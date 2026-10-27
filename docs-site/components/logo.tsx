// The Terminal mark: a command prompt and cursor in a rounded window. The
// same drawing is used for the desktop icon and the landing page.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={className}>
      <rect x="70" y="88" width="372" height="336" rx="54" fill="none" stroke="currentColor" strokeWidth="42" />
      <path d="M151 191l69 65-69 65" fill="none" stroke="var(--berth-amber)" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M270 326h94" fill="none" stroke="currentColor" strokeWidth="42" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="berth-brand">
      <Mark className="berth-brand-mark" />
      <span className="berth-brand-word">terminal</span>
      <span className="berth-brand-docs">docs</span>
    </span>
  );
}
