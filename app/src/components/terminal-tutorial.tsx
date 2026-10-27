import { ArrowLeftIcon, ArrowRightIcon, BookOpenIcon, CheckIcon, GitBranchIcon, GitCommitHorizontalIcon, ListTodoIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { isMock } from "@/hooks/use-berth-connection";
import { useStore } from "@/lib/store";
import { TERMINAL_TUTORIAL_EVENT } from "@/lib/terminal-tutorial";
import { cn } from "@/lib/utils";

const STEP_COUNT = 5;

export function TerminalTutorial() {
  const requested = new URLSearchParams(location.search).has("tutorial");
  const [open, setOpen] = useState(requested);
  const [step, setStep] = useState(0);
  const practice = isMock();
  const connected = useStore((state) => !!state.client);

  useEffect(() => {
    const show = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(TERMINAL_TUTORIAL_EVENT, show);
    return () => window.removeEventListener(TERMINAL_TUTORIAL_EVENT, show);
  }, []);

  if (!open || !connected) return null;

  const close = () => setOpen(false);
  const next = () => {
    if (step === STEP_COUNT - 1) {
      close();
      return;
    }
    // The rest of the tutorial explains the activity board, so keep the
    // screen behind the guide in sync with the lesson.
    useStore.getState().setView({ kind: "worktrees" });
    setStep((current) => current + 1);
  };

  return (
    <section aria-labelledby="terminal-tutorial-title" aria-live="polite" className="fixed right-3 bottom-[calc(var(--berth-status-h,26px)+12px)] z-50 w-96 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl/10">
      <header className="flex items-start gap-3 border-b px-3 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info-foreground">
          <BookOpenIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-tag font-medium uppercase tracking-wide text-muted-foreground">Terminal tutorial · {step + 1} of {STEP_COUNT}</p>
          <h2 id="terminal-tutorial-title" className="mt-0.5 font-heading text-section-title">
            <StepTitle step={step} />
          </h2>
        </div>
        <Tip label="Close tutorial">
          <Button size="icon-xs" variant="ghost" aria-label="Close tutorial" onClick={close} className="-mt-1 -mr-1 text-muted-foreground">
            <XIcon />
          </Button>
        </Tip>
      </header>

      <div className="min-h-44 px-3 py-3 text-desc">
        <StepBody step={step} practice={practice} />
      </div>

      <footer className="flex items-center gap-2 border-t px-3 py-2">
        <div className="flex gap-1" aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
          {Array.from({ length: STEP_COUNT }, (_, index) => (
            <span key={index} className={cn("h-1.5 w-5 rounded-full", index <= step ? "bg-foreground" : "bg-muted")} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {step > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setStep((current) => current - 1)}>
              <ArrowLeftIcon />
              Back
            </Button>
          )}
          <Button size="xs" onClick={next}>
            {step === 0 ? "Show project activity" : step === STEP_COUNT - 1 ? "Finish" : "Next"}
            {step < STEP_COUNT - 1 && <ArrowRightIcon />}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function StepTitle({ step }: { step: number }) {
  return ["Welcome to Terminal", "Connect your GitLab project", "Read the Todo board", "Follow every push and pull", "Guide the agent to done"][step];
}

function StepBody({ step, practice }: { step: number; practice: boolean }) {
  if (step === 0) {
    return (
      <div className="space-y-3">
        <p>Terminal turns repository branches into a simple workflow you can scan without reading terminal logs.</p>
        <p className="rounded-lg border bg-muted/30 p-3 text-meta text-muted-foreground">
          {practice ? "This practice workspace is safe to explore. Actions stay here and do not change a real repository." : "This tour uses the projects already connected to Terminal and does not start or stop an agent."}
        </p>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="space-y-3">
        <p>Choose <strong>Connect GitLab</strong>, paste the repository URL, then select the computer that should run its agents.</p>
        <TutorialPoint icon={<GitBranchIcon />} title="One project, every branch" detail="Terminal watches the main checkout and each agent worktree together." />
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className="space-y-3">
        <p>The board answers “what needs attention?” before you open a branch.</p>
        <div className="grid grid-cols-3 gap-2">
          <Stage label="Todo" detail="Waiting" />
          <Stage label="In progress" detail="Agent active" active />
          <Stage label="Done" detail="Ready to review" done />
        </div>
      </div>
    );
  }
  if (step === 3) {
    return (
      <div className="space-y-3">
        <p>Each branch card shows its latest commit and remote state. You can see whether work is local, published, or waiting to sync.</p>
        <div className="flex flex-wrap gap-2 text-tag">
          <span className="rounded bg-info/10 px-2 py-1 text-info-foreground">2 to push</span>
          <span className="rounded bg-warning/12 px-2 py-1 text-warning-foreground">1 to pull</span>
          <span className="rounded bg-success/10 px-2 py-1 text-success-foreground">Synced</span>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p>Open a branch card to inspect commits, changed files, and the assigned agent. From there you can sync, pause, resume, or open the worktree.</p>
      <TutorialPoint icon={<GitCommitHorizontalIcon />} title="Review the evidence" detail="Use the commit history and file changes to decide what the agent should do next." />
      <TutorialPoint icon={<CheckIcon />} title="Come back anytime" detail="The Tutorial button in the status bar reopens this guide." />
    </div>
  );
}

function TutorialPoint({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border p-2.5">
      <span className="mt-0.5 text-info-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0">
        <strong className="block font-medium text-body">{title}</strong>
        <span className="text-meta text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}

function Stage({ label, detail, active, done }: { label: string; detail: string; active?: boolean; done?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-2 text-center">
      <span className={cn("mx-auto mb-1 flex size-6 items-center justify-center rounded-full", done ? "bg-success/10 text-success-foreground" : active ? "bg-info/10 text-info-foreground" : "bg-muted text-muted-foreground")}>
        {done ? <CheckIcon className="size-3" /> : active ? <GitBranchIcon className="size-3" /> : <ListTodoIcon className="size-3" />}
      </span>
      <strong className="block text-tag">{label}</strong>
      <span className="text-tag text-muted-foreground">{detail}</span>
    </div>
  );
}
