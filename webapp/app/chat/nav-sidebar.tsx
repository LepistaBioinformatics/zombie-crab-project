import Logo from "@/app/logo";
import LogoutButton from "./logout-button";
import WorkspaceNav from "./workspace-nav";

// First sidebar (M3 navigation drawer): everything that is NOT a chat session
// -- branding, the sectioned navigator (Workspaces now, room for more), and
// the account footer. Sections are uniform (SectionHeader + body) so adding a
// future one is additive, not a restructure.
export default function NavSidebar({ email, onSelect }: { email: string; onSelect?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 px-4 py-4">
        <Logo size={32} />
        <span className="font-display text-base font-semibold text-fg">zombie-crab</span>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-2">
        <Section label="Workspaces">
          <WorkspaceNav onSelect={onSelect} />
        </Section>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-brand/20 px-4 py-3">
        <span className="min-w-0 truncate text-sm text-fg-muted" title={email}>
          {email}
        </span>
        <LogoutButton />
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="py-2">
      <div className="mb-1 flex items-center gap-2 px-2">
        <span className="h-2 w-2 bg-accent" aria-hidden />
        <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {label}
        </h2>
      </div>
      {children}
    </section>
  );
}
