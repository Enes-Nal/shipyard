package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
)

// GatewayEndpoints are the OpenAI-compatible provider roots used by the
// local Shipkit gateway. They are configurable so tests never call the web.
type GatewayEndpoints struct {
	OpenRouter string
	Gemini     string
}

const (
	gatewaySecretsFile = "gateway-secrets.json"
	gatewayPolicyFile  = "gateway-policy.json"
	gatewayBodyLimit   = 8 << 20
	gatewayCatalogTTL  = 15 * time.Minute
)

type gatewaySecrets struct {
	Gemini     string `json:"gemini,omitempty"`
	OpenRouter string `json:"openrouter,omitempty"`
}

type gatewayState struct {
	mu       sync.Mutex
	catalogs map[string]gatewayCatalog
}

type gatewayCatalog struct {
	at     time.Time
	keyID  [32]byte
	models []GatewayModel
}

// GatewayModel is an OpenAI model entry with the metadata Shipkit needs to
// route. RawID is deliberately omitted from JSON; callers use the namespaced
// ID, while the gateway alone knows the provider-specific value.
type GatewayModel struct {
	ID            string   `json:"id"`
	Object        string   `json:"object"`
	Created       int64    `json:"created,omitempty"`
	OwnedBy       string   `json:"owned_by"`
	Provider      string   `json:"provider"`
	Name          string   `json:"name,omitempty"`
	ContextLength int64    `json:"context_length,omitempty"`
	PromptPrice   string   `json:"prompt_price,omitempty"`
	OutputPrice   string   `json:"output_price,omitempty"`
	Protocols     []string `json:"protocols,omitempty"`
	RawID         string   `json:"-"`
}

type gatewayProviderStatus struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
	Source     string `json:"source,omitempty"`
}

type gatewayStatus struct {
	Enabled   bool                    `json:"enabled"`
	BaseURL   string                  `json:"base_url"`
	AutoModel string                  `json:"auto_model"`
	Providers []gatewayProviderStatus `json:"providers"`
	Policy    gatewayPolicy           `json:"policy"`
}

type gatewayPolicy struct {
	Objective string          `json:"objective"`
	Providers map[string]bool `json:"providers"`
}

func (a *Agent) gatewayRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/gateway", a.gatewayStatus)
	mux.HandleFunc("PUT /v1/gateway/providers/{provider}", a.gatewayPutProvider)
	mux.HandleFunc("DELETE /v1/gateway/providers/{provider}", a.gatewayDeleteProvider)
	mux.HandleFunc("PUT /v1/gateway/policy", a.gatewayPutPolicy)
	mux.HandleFunc("GET /v1/gateway/models", a.gatewayModels)
	// OpenAI-compatible routes for Codex and other clients. Claude Code uses
	// Anthropic's Messages protocol, which is intentionally not faked here.
	mux.HandleFunc("GET /gateway/v1/models", a.gatewayModels)
	mux.HandleFunc("POST /gateway/v1/chat/completions", a.gatewayChatCompletions)
	mux.HandleFunc("POST /gateway/v1/responses", a.gatewayResponses)
}

func (a *Agent) gatewaySecretsPath() string {
	return filepath.Join(a.cfg.Dir, gatewaySecretsFile)
}

func (a *Agent) gatewayPolicyPath() string {
	return filepath.Join(a.cfg.Dir, gatewayPolicyFile)
}

func defaultGatewayPolicy() gatewayPolicy {
	return gatewayPolicy{Objective: "balanced", Providers: map[string]bool{"gemini": true, "openrouter": true}}
}

func normalizeGatewayPolicy(policy gatewayPolicy) gatewayPolicy {
	normalized := defaultGatewayPolicy()
	if policy.Objective == "usage" || policy.Objective == "quality" || policy.Objective == "balanced" {
		normalized.Objective = policy.Objective
	}
	for _, provider := range []string{"gemini", "openrouter"} {
		if value, ok := policy.Providers[provider]; ok {
			normalized.Providers[provider] = value
		}
	}
	return normalized
}

func (a *Agent) readGatewayPolicy() (gatewayPolicy, error) {
	b, err := os.ReadFile(a.gatewayPolicyPath())
	if os.IsNotExist(err) {
		return defaultGatewayPolicy(), nil
	}
	if err != nil {
		return gatewayPolicy{}, err
	}
	var policy gatewayPolicy
	if err := json.Unmarshal(b, &policy); err != nil {
		return gatewayPolicy{}, fmt.Errorf("reading gateway policy: %w", err)
	}
	return normalizeGatewayPolicy(policy), nil
}

func (a *Agent) gatewayPutPolicy(w http.ResponseWriter, r *http.Request) {
	var policy gatewayPolicy
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&policy); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	policy = normalizeGatewayPolicy(policy)
	b, err := json.Marshal(policy)
	if err == nil {
		err = statefile.Write(a.gatewayPolicyPath(), append(b, '\n'))
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.gatewayStatus(w, r)
}

func (a *Agent) readGatewaySecrets() (gatewaySecrets, error) {
	var secrets gatewaySecrets
	b, err := os.ReadFile(a.gatewaySecretsPath())
	if os.IsNotExist(err) {
		return secrets, nil
	}
	if err != nil {
		return secrets, err
	}
	if err := json.Unmarshal(b, &secrets); err != nil {
		return secrets, fmt.Errorf("reading gateway credentials: %w", err)
	}
	return secrets, nil
}

func (a *Agent) writeGatewaySecrets(change func(*gatewaySecrets)) error {
	a.gateway.mu.Lock()
	defer a.gateway.mu.Unlock()
	unlock, err := statefile.Lock(a.gatewaySecretsPath())
	if err != nil {
		return err
	}
	defer unlock()
	secrets, err := a.readGatewaySecrets()
	if err != nil {
		return err
	}
	change(&secrets)
	b, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	if err := statefile.Write(a.gatewaySecretsPath(), append(b, '\n')); err != nil {
		return err
	}
	a.gateway.catalogs = nil
	return nil
}

func (a *Agent) gatewayKey(provider string) (key, source string, err error) {
	secrets, err := a.readGatewaySecrets()
	if err != nil {
		return "", "", err
	}
	switch provider {
	case "gemini":
		if secrets.Gemini != "" {
			return secrets.Gemini, "stored", nil
		}
		if key := strings.TrimSpace(os.Getenv("GEMINI_API_KEY")); key != "" {
			return key, "environment", nil
		}
	case "openrouter":
		if secrets.OpenRouter != "" {
			return secrets.OpenRouter, "stored", nil
		}
		if key := strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")); key != "" {
			return key, "environment", nil
		}
	default:
		return "", "", fmt.Errorf("unknown gateway provider %q", provider)
	}
	return "", "", nil
}

func (a *Agent) gatewayProviderStatuses() ([]gatewayProviderStatus, error) {
	providers := []gatewayProviderStatus{{ID: "gemini", Name: "Gemini"}, {ID: "openrouter", Name: "OpenRouter"}}
	for i := range providers {
		key, source, err := a.gatewayKey(providers[i].ID)
		if err != nil {
			return nil, err
		}
		providers[i].Configured = key != ""
		providers[i].Source = source
	}
	return providers, nil
}

func (a *Agent) gatewayStatus(w http.ResponseWriter, r *http.Request) {
	providers, err := a.gatewayProviderStatuses()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	enabled := false
	for _, p := range providers {
		enabled = enabled || p.Configured
	}
	policy, err := a.readGatewayPolicy()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	addr := a.cfg.UIAddr
	if addr == "" {
		addr = "127.0.0.1:" + strconv.Itoa(DefaultUIPort)
	}
	writeJSON(w, http.StatusOK, gatewayStatus{
		Enabled: enabled, BaseURL: "http://" + addr + "/gateway/v1", AutoModel: "shipkit/auto", Providers: providers, Policy: policy,
	})
}

func validGatewayProvider(provider string) bool {
	return provider == "gemini" || provider == "openrouter"
}

func (a *Agent) gatewayPutProvider(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if !validGatewayProvider(provider) {
		writeError(w, http.StatusNotFound, "unknown gateway provider")
		return
	}
	var req struct {
		APIKey string `json:"api_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	key := strings.TrimSpace(req.APIKey)
	if len(key) < 8 {
		writeError(w, http.StatusBadRequest, "API key is required")
		return
	}
	if err := a.writeGatewaySecrets(func(secrets *gatewaySecrets) {
		if provider == "gemini" {
			secrets.Gemini = key
		} else {
			secrets.OpenRouter = key
		}
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.gatewayStatus(w, r)
}

func (a *Agent) gatewayDeleteProvider(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if !validGatewayProvider(provider) {
		writeError(w, http.StatusNotFound, "unknown gateway provider")
		return
	}
	if err := a.writeGatewaySecrets(func(secrets *gatewaySecrets) {
		if provider == "gemini" {
			secrets.Gemini = ""
		} else {
			secrets.OpenRouter = ""
		}
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.gatewayStatus(w, r)
}

func (a *Agent) gatewayEndpoint(provider string) string {
	if provider == "gemini" {
		return strings.TrimRight(a.cfg.GatewayEndpoints.Gemini, "/")
	}
	return strings.TrimRight(a.cfg.GatewayEndpoints.OpenRouter, "/")
}

func (a *Agent) gatewayCatalog(ctx context.Context, provider string) ([]GatewayModel, error) {
	key, _, err := a.gatewayKey(provider)
	if err != nil || key == "" {
		return nil, err
	}
	keyID := sha256.Sum256([]byte(key))
	now := a.cfg.Now()
	a.gateway.mu.Lock()
	if cached, ok := a.gateway.catalogs[provider]; ok && cached.keyID == keyID && now.Sub(cached.at) < gatewayCatalogTTL {
		models := append([]GatewayModel(nil), cached.models...)
		a.gateway.mu.Unlock()
		return models, nil
	}
	a.gateway.mu.Unlock()

	catalogCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(catalogCtx, http.MethodGet, a.gatewayEndpoint(provider)+"/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := a.cfg.GatewayHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s model catalog returned %s", provider, resp.Status)
	}
	var payload struct {
		Data []struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			Created       int64  `json:"created"`
			OwnedBy       string `json:"owned_by"`
			ContextLength int64  `json:"context_length"`
			Pricing       struct {
				Prompt     string `json:"prompt"`
				Completion string `json:"completion"`
			} `json:"pricing"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("reading %s model catalog: %w", provider, err)
	}
	models := make([]GatewayModel, 0, len(payload.Data))
	for _, model := range payload.Data {
		raw := strings.TrimPrefix(model.ID, "models/")
		if raw == "" {
			continue
		}
		owner := model.OwnedBy
		if owner == "" {
			owner = provider
		}
		models = append(models, GatewayModel{
			ID: provider + "/" + raw, Object: "model", Created: model.Created, OwnedBy: owner,
			Provider: provider, Name: model.Name, ContextLength: model.ContextLength,
			PromptPrice: model.Pricing.Prompt, OutputPrice: model.Pricing.Completion, Protocols: gatewayProviderProtocols(provider), RawID: raw,
		})
	}
	sort.SliceStable(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	a.gateway.mu.Lock()
	if a.gateway.catalogs == nil {
		a.gateway.catalogs = map[string]gatewayCatalog{}
	}
	a.gateway.catalogs[provider] = gatewayCatalog{at: now, keyID: keyID, models: append([]GatewayModel(nil), models...)}
	a.gateway.mu.Unlock()
	return models, nil
}

func (a *Agent) allGatewayModels(ctx context.Context) ([]GatewayModel, []string) {
	type result struct {
		models []GatewayModel
		err    error
	}
	results := make(chan result, 2)
	configured := 0
	for _, provider := range []string{"gemini", "openrouter"} {
		key, _, err := a.gatewayKey(provider)
		if err != nil || key == "" {
			continue
		}
		configured++
		go func(provider string) {
			models, err := a.gatewayCatalog(ctx, provider)
			results <- result{models: models, err: err}
		}(provider)
	}
	var models []GatewayModel
	var errs []string
	for range configured {
		result := <-results
		if result.err != nil {
			errs = append(errs, result.err.Error())
		} else {
			models = append(models, result.models...)
		}
	}
	sort.SliceStable(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, errs
}

func (a *Agent) gatewayModels(w http.ResponseWriter, r *http.Request) {
	models, errs := a.allGatewayModels(r.Context())
	if len(models) > 0 {
		protocols := []string{"chat.completions"}
		if len(gatewayModelsForProvider(models, "openrouter")) > 0 {
			protocols = append(protocols, "responses")
		}
		models = append([]GatewayModel{{ID: "shipkit/auto", Object: "model", OwnedBy: "shipkit", Provider: "shipkit", Name: "Shipkit Auto", Protocols: protocols}}, models...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": models, "errors": errs})
}

func gatewayProviderProtocols(provider string) []string {
	if provider == "openrouter" {
		return []string{"chat.completions", "responses"}
	}
	return []string{"chat.completions"}
}

type gatewayAttempt struct {
	provider string
	model    GatewayModel
}

func (a *Agent) gatewayChatCompletions(w http.ResponseWriter, r *http.Request) {
	a.gatewayInference(w, r, "chat/completions")
}

func (a *Agent) gatewayResponses(w http.ResponseWriter, r *http.Request) {
	a.gatewayInference(w, r, "responses")
}

func (a *Agent) gatewayInference(w http.ResponseWriter, r *http.Request, protocol string) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, gatewayBodyLimit))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		writeError(w, http.StatusBadRequest, "request must be valid JSON")
		return
	}
	var requested string
	if json.Unmarshal(payload["model"], &requested) != nil || requested == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	models, catalogErrs := a.allGatewayModels(r.Context())
	if protocol == "responses" {
		// OpenRouter exposes an OpenResponses endpoint. Gemini's documented
		// OpenAI compatibility is Chat Completions, so never send it a
		// Responses request and pretend the protocols are interchangeable.
		models = gatewayModelsForProvider(models, "openrouter")
	}
	if len(models) == 0 {
		msg := "connect Gemini or OpenRouter in Shipkit Routing settings"
		if protocol == "responses" {
			msg = "connect OpenRouter in Shipkit Routing settings to use the Responses API"
		}
		if len(catalogErrs) > 0 {
			msg = strings.Join(catalogErrs, "; ")
		}
		writeError(w, http.StatusServiceUnavailable, msg)
		return
	}
	model, ok := findGatewayModel(requested, models)
	if requested == "shipkit/auto" {
		policy, err := a.readGatewayPolicy()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		models = gatewayModelsAllowedByPolicy(models, policy)
		objective := strings.ToLower(r.Header.Get("X-Shipkit-Objective"))
		if objective == "" {
			objective = policy.Objective
		}
		model, ok = chooseGatewayModel(gatewayPrompt(payload), objective, models)
	}
	if !ok {
		writeError(w, http.StatusBadRequest, "model is not available from a connected provider")
		return
	}
	attempts := []gatewayAttempt{{provider: model.Provider, model: model}}
	if fallback, found := sameGatewayModelAnotherProvider(model, models); found {
		attempts = append(attempts, gatewayAttempt{provider: fallback.Provider, model: fallback})
	}

	for i, attempt := range attempts {
		forwardBody, err := rewriteGatewayModel(payload, attempt.model.RawID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "request could not be encoded")
			return
		}
		resp, err := a.gatewayInferenceRequest(r.Context(), attempt, protocol, forwardBody, r.Header)
		if err != nil {
			if i+1 < len(attempts) {
				continue
			}
			writeError(w, http.StatusBadGateway, "the model provider could not be reached")
			return
		}
		if shouldGatewayFailover(resp.StatusCode) && i+1 < len(attempts) {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			continue
		}
		defer resp.Body.Close()
		copyGatewayHeaders(w.Header(), resp.Header)
		w.Header().Set("X-Shipkit-Provider", attempt.provider)
		w.Header().Set("X-Shipkit-Model", attempt.model.RawID)
		if i > 0 {
			w.Header().Set("X-Shipkit-Route", "same-model-fallback")
		} else if requested == "shipkit/auto" {
			w.Header().Set("X-Shipkit-Route", "auto")
		} else {
			w.Header().Set("X-Shipkit-Route", "explicit")
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
}

func (a *Agent) gatewayInferenceRequest(ctx context.Context, attempt gatewayAttempt, protocol string, body []byte, incoming http.Header) (*http.Response, error) {
	key, _, err := a.gatewayKey(attempt.provider)
	if err != nil || key == "" {
		return nil, errors.New("provider is not connected")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.gatewayEndpoint(attempt.provider)+"/"+protocol, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	if accept := incoming.Get("Accept"); accept != "" {
		req.Header.Set("Accept", accept)
	}
	return a.cfg.GatewayHTTP.Do(req)
}

func rewriteGatewayModel(payload map[string]json.RawMessage, model string) ([]byte, error) {
	b, err := json.Marshal(model)
	if err != nil {
		return nil, err
	}
	copy := make(map[string]json.RawMessage, len(payload))
	for key, value := range payload {
		copy[key] = value
	}
	copy["model"] = b
	return json.Marshal(copy)
}

func findGatewayModel(id string, models []GatewayModel) (GatewayModel, bool) {
	for _, model := range models {
		if model.ID == id {
			return model, true
		}
	}
	return GatewayModel{}, false
}

func gatewayModelsForProvider(models []GatewayModel, provider string) []GatewayModel {
	filtered := make([]GatewayModel, 0, len(models))
	for _, model := range models {
		if model.Provider == provider {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func gatewayModelsAllowedByPolicy(models []GatewayModel, policy gatewayPolicy) []GatewayModel {
	filtered := make([]GatewayModel, 0, len(models))
	for _, model := range models {
		if policy.Providers[model.Provider] {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func sameGatewayModelAnotherProvider(model GatewayModel, models []GatewayModel) (GatewayModel, bool) {
	var otherID string
	if model.Provider == "gemini" {
		otherID = "google/" + strings.TrimPrefix(model.RawID, "models/")
	} else if model.Provider == "openrouter" {
		otherID = strings.TrimPrefix(model.RawID, "google/")
		if otherID == model.RawID || !strings.HasPrefix(otherID, "gemini-") {
			return GatewayModel{}, false
		}
	} else {
		return GatewayModel{}, false
	}
	for _, candidate := range models {
		if candidate.Provider != model.Provider && strings.TrimPrefix(candidate.RawID, "models/") == otherID {
			return candidate, true
		}
	}
	return GatewayModel{}, false
}

func shouldGatewayFailover(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
}

func copyGatewayHeaders(dst, src http.Header) {
	for _, key := range []string{"Content-Type", "Cache-Control", "Retry-After", "X-Request-ID"} {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}
}

func gatewayPrompt(payload map[string]json.RawMessage) string {
	var value any
	input := payload["messages"]
	if len(input) == 0 {
		input = payload["input"]
	}
	if json.Unmarshal(input, &value) != nil {
		return ""
	}
	var parts []string
	collectGatewayText(value, &parts, 24)
	var instructions string
	if json.Unmarshal(payload["instructions"], &instructions) == nil && instructions != "" {
		parts = append([]string{instructions}, parts...)
	}
	return strings.Join(parts, "\n")
}

func collectGatewayText(value any, parts *[]string, remaining int) {
	if remaining <= 0 || len(*parts) >= 24 {
		return
	}
	switch value := value.(type) {
	case string:
		*parts = append(*parts, value)
	case []any:
		for _, item := range value {
			collectGatewayText(item, parts, remaining-1)
		}
	case map[string]any:
		for key, item := range value {
			if key == "content" || key == "text" || key == "input" {
				collectGatewayText(item, parts, remaining-1)
			}
		}
	}
}

func chooseGatewayModel(prompt, objective string, models []GatewayModel) (GatewayModel, bool) {
	tier := gatewayTaskTier(prompt, objective)
	bestScore := -1 << 30
	var best GatewayModel
	for _, model := range models {
		id := strings.ToLower(model.RawID)
		if strings.Contains(id, "embed") || strings.Contains(id, "image") || strings.Contains(id, "audio") || strings.Contains(id, "tts") || strings.Contains(id, "moderation") {
			continue
		}
		score := gatewayModelScore(model, tier)
		if score > bestScore || (score == bestScore && model.ID < best.ID) {
			bestScore, best = score, model
		}
	}
	return best, bestScore > -1<<30
}

func gatewayTaskTier(prompt, objective string) string {
	text := strings.ToLower(prompt)
	tier := "balanced"
	for _, hint := range []string{"typo", "format", "rename", "readme", "small fix", "explain", "summarize"} {
		if strings.Contains(text, hint) && len(text) < 800 {
			tier = "economy"
			break
		}
	}
	for _, hint := range []string{"architecture", "migration", "rewrite", "security", "authentication", "race condition", "data loss", "production incident", "entire codebase"} {
		if strings.Contains(text, hint) {
			tier = "frontier"
			break
		}
	}
	if objective == "usage" && tier == "balanced" {
		return "economy"
	}
	if objective == "usage" && tier == "frontier" {
		return "balanced"
	}
	if objective == "quality" && tier == "economy" {
		return "balanced"
	}
	if objective == "quality" && tier == "balanced" {
		return "frontier"
	}
	return tier
}

func gatewayModelScore(model GatewayModel, tier string) int {
	id := strings.ToLower(model.RawID + " " + model.Name)
	score := 0
	// Direct Gemini avoids another intermediary when the same family exists.
	if model.Provider == "gemini" {
		score += 8
	}
	patterns := map[string][]struct {
		term  string
		score int
	}{
		"economy":  {{"flash-lite", 70}, {"flash", 55}, {"mini", 45}, {"small", 40}, {"free", 35}, {"coder", 12}},
		"balanced": {{"coder", 60}, {"flash", 48}, {"pro", 45}, {"sonnet", 42}, {"gpt", 30}},
		"frontier": {{"opus", 75}, {"pro", 65}, {"reasoning", 58}, {"max", 55}, {"coder", 35}},
	}
	for _, pattern := range patterns[tier] {
		if strings.Contains(id, pattern.term) {
			score += pattern.score
		}
	}
	if model.PromptPrice == "0" && model.OutputPrice == "0" {
		if tier == "economy" {
			score += 30
		} else {
			score += 4
		}
	}
	if model.ContextLength >= 100_000 {
		score += 6
	}
	return score
}
