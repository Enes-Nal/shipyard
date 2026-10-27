package agent

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func testGatewayAgent(t *testing.T, upstream *httptest.Server) *Agent {
	t.Helper()
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	cfg := Config{
		Dir: t.TempDir(), Log: log.New(io.Discard, "", 0),
		GatewayEndpoints: GatewayEndpoints{Gemini: upstream.URL + "/gemini", OpenRouter: upstream.URL + "/openrouter"},
	}
	cfg.defaults()
	return &Agent{cfg: cfg}
}

func TestGatewayResponsesRouteSupportsCodex(t *testing.T) {
	var gotPath, gotModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/openrouter/models":
			io.WriteString(w, `{"data":[{"id":"openai/gpt-5-codex","name":"GPT-5 Codex","context_length":200000}]}`)
		case "/openrouter/responses":
			gotPath = r.URL.Path
			var req struct {
				Model string `json:"model"`
			}
			json.NewDecoder(r.Body).Decode(&req)
			gotModel = req.Model
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "event: response.completed\ndata: {}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "openrouter", "openrouter-key")

	w := gatewayCall(t, a, http.MethodPost, "/gateway/v1/responses", `{"model":"shipkit/auto","stream":true,"input":"review this architecture"}`)
	if w.Code != http.StatusOK || gotPath != "/openrouter/responses" || gotModel != "openai/gpt-5-codex" {
		t.Fatalf("response = %d %s; upstream = %s %s", w.Code, w.Body.String(), gotPath, gotModel)
	}
	if w.Header().Get("X-Shipkit-Route") != "auto" {
		t.Fatalf("route = %q, want auto", w.Header().Get("X-Shipkit-Route"))
	}
}

func TestGatewayResponsesNeverPretendGeminiSupportsTheProtocol(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/gemini/models" {
			io.WriteString(w, `{"data":[{"id":"gemini-2.5-pro"}]}`)
			return
		}
		t.Fatalf("unexpected Gemini request: %s", r.URL.Path)
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-key")

	w := gatewayCall(t, a, http.MethodPost, "/gateway/v1/responses", `{"model":"shipkit/auto","input":"hello"}`)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "connect OpenRouter") {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
}

func TestGatewayAutoObeysStoredProviderPolicy(t *testing.T) {
	var used string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gemini/models":
			io.WriteString(w, `{"data":[{"id":"gemini-2.5-flash"}]}`)
		case "/openrouter/models":
			io.WriteString(w, `{"data":[{"id":"openai/gpt-5-codex"}]}`)
		case "/gemini/chat/completions":
			t.Fatal("disabled Gemini provider received an automatic route")
		case "/openrouter/chat/completions":
			used = "openrouter"
			io.WriteString(w, `{"choices":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-key")
	connectGatewayProvider(t, a, "openrouter", "openrouter-key")

	w := gatewayCall(t, a, http.MethodPut, "/v1/gateway/policy", `{"objective":"quality","providers":{"gemini":false,"openrouter":true}}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"objective":"quality"`) {
		t.Fatalf("policy: %d %s", w.Code, w.Body.String())
	}
	w = gatewayCall(t, a, http.MethodPost, "/gateway/v1/chat/completions", `{"model":"shipkit/auto","messages":[{"role":"user","content":"fix this"}]}`)
	if w.Code != http.StatusOK || used != "openrouter" {
		t.Fatalf("completion: %d %s, used %q", w.Code, w.Body.String(), used)
	}
}

func gatewayCall(t *testing.T, a *Agent, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	a.api(func() {}).ServeHTTP(w, req)
	return w
}

func connectGatewayProvider(t *testing.T, a *Agent, provider, key string) {
	t.Helper()
	w := gatewayCall(t, a, http.MethodPut, "/v1/gateway/providers/"+provider, `{"api_key":"`+key+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("connect %s: %d %s", provider, w.Code, w.Body.String())
	}
}

func TestGatewayCredentialsStayPrivate(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-secret-key")

	w := gatewayCall(t, a, http.MethodGet, "/v1/gateway", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"configured":true`) || strings.Contains(w.Body.String(), "gemini-secret-key") {
		t.Fatalf("status exposed or omitted the credential state: %d %s", w.Code, w.Body.String())
	}
	info, err := os.Stat(filepath.Join(a.cfg.Dir, gatewaySecretsFile))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential file mode = %o, want 600", info.Mode().Perm())
	}

	w = gatewayCall(t, a, http.MethodDelete, "/v1/gateway/providers/gemini", "")
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"configured":true`) {
		t.Fatalf("disconnect: %d %s", w.Code, w.Body.String())
	}
}

func TestGatewayListsNamespacedLiveModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Fatal("provider request had no authorization")
		}
		switch r.URL.Path {
		case "/gemini/models":
			io.WriteString(w, `{"object":"list","data":[{"id":"models/gemini-2.5-flash","owned_by":"google"}]}`)
		case "/openrouter/models":
			io.WriteString(w, `{"data":[{"id":"anthropic/claude-sonnet-4","name":"Claude Sonnet 4","context_length":200000,"pricing":{"prompt":"0.000003","completion":"0.000015"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-key")
	connectGatewayProvider(t, a, "openrouter", "openrouter-key")

	w := gatewayCall(t, a, http.MethodGet, "/gateway/v1/models", "")
	for _, want := range []string{`"id":"shipkit/auto"`, `"id":"gemini/gemini-2.5-flash"`, `"id":"openrouter/anthropic/claude-sonnet-4"`} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("models missing %s: %s", want, w.Body.String())
		}
	}
}

func TestGatewayStreamsAndFailsOverOnlyToTheSameModel(t *testing.T) {
	var mu sync.Mutex
	var calls []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gemini/models":
			io.WriteString(w, `{"data":[{"id":"gemini-2.5-pro"}]}`)
		case "/openrouter/models":
			io.WriteString(w, `{"data":[{"id":"google/gemini-2.5-pro"},{"id":"anthropic/claude-opus-4"}]}`)
		case "/gemini/chat/completions", "/openrouter/chat/completions":
			var req struct {
				Model string `json:"model"`
			}
			json.NewDecoder(r.Body).Decode(&req)
			mu.Lock()
			calls = append(calls, r.URL.Path+":"+req.Model)
			mu.Unlock()
			if strings.HasPrefix(r.URL.Path, "/gemini/") {
				w.WriteHeader(http.StatusServiceUnavailable)
				io.WriteString(w, `{"error":"temporary"}`)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: one\n\ndata: two\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-key")
	connectGatewayProvider(t, a, "openrouter", "openrouter-key")

	w := gatewayCall(t, a, http.MethodPost, "/gateway/v1/chat/completions", `{"model":"gemini/gemini-2.5-pro","stream":true,"messages":[{"role":"user","content":"review this architecture"}]}`)
	if w.Code != http.StatusOK || w.Body.String() != "data: one\n\ndata: two\n\n" {
		t.Fatalf("completion: %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Shipkit-Provider") != "openrouter" || w.Header().Get("X-Shipkit-Route") != "same-model-fallback" {
		t.Fatalf("route headers: %v", w.Header())
	}
	mu.Lock()
	gotCalls := append([]string(nil), calls...)
	mu.Unlock()
	wantCalls := []string{"/gemini/chat/completions:gemini-2.5-pro", "/openrouter/chat/completions:google/gemini-2.5-pro"}
	if strings.Join(gotCalls, "|") != strings.Join(wantCalls, "|") {
		t.Fatalf("calls = %v, want %v", gotCalls, wantCalls)
	}
}

func TestGatewayDoesNotSilentlyChangeModels(t *testing.T) {
	completionCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gemini/models":
			io.WriteString(w, `{"data":[{"id":"gemini-2.5-pro"}]}`)
		case "/openrouter/models":
			io.WriteString(w, `{"data":[{"id":"anthropic/claude-opus-4"}]}`)
		case "/gemini/chat/completions":
			completionCalls++
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, `{"error":"temporary"}`)
		case "/openrouter/chat/completions":
			completionCalls++
			t.Fatal("gateway changed models without approval")
		}
	}))
	defer upstream.Close()
	a := testGatewayAgent(t, upstream)
	connectGatewayProvider(t, a, "gemini", "gemini-key")
	connectGatewayProvider(t, a, "openrouter", "openrouter-key")

	w := gatewayCall(t, a, http.MethodPost, "/gateway/v1/chat/completions", `{"model":"gemini/gemini-2.5-pro","messages":[{"role":"user","content":"review this architecture"}]}`)
	if w.Code != http.StatusServiceUnavailable || completionCalls != 1 {
		t.Fatalf("response = %d %s, calls = %d", w.Code, w.Body.String(), completionCalls)
	}
}
