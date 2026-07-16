import Logo from "@/app/logo";

// Shown in the content pane when no workspace is selected -- the second
// sidebar and chat view only exist for a chosen workspace.
export default function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo size={56} />
      <div>
        <h1 className="font-display text-2xl font-bold text-fg">Pick a workspace to start</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-fg-muted">
          Choose a tenant, account, and agent on the left. Its conversations open in a second panel,
          ready for you to type.
        </p>
      </div>
    </div>
  );
}
