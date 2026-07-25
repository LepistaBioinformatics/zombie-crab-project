# Model Registry Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two competing model-selection systems in `crab-shell-proxy` with one proxy-level model inventory that is the single answer to "which model does this workspace use", tracks which workspaces use which model, blocks deleting or disabling a model in use, and retires an in-use model only via deprecation with a named replacement.

**Architecture:** A new `internal/registry` package owns a bbolt database at `<containerDataRoot>/model-registry.db` with four buckets (`models`, `assignments`, `scope_defaults`, `meta`). One exported `Resolve` walks the cascade user assignment → subscription → tenant → agent → global, following `replaced_by` only for workspaces with no materialized assignment. `internal/docker` materializes the resolved primary plus its declared fallback chain into each workspace's `config.json` (no `api_key`) and `.security.yml` (keys, with pruning). A one-time boot migration seeds the inventory from every pre-existing source and records what each workspace is currently running, so nothing is orphaned.

**Tech Stack:** Go 1.23 (`CGO_ENABLED=0`), `go.etcd.io/bbolt`, `gopkg.in/yaml.v3`, Next.js 15 App Router, TypeScript, Tailwind v4 + class-variance-authority, vitest.

## Global Constraints

- Go module is `github.com/LepistaBioinformatics/crab-shell-proxy`, Go 1.23. `CGO_ENABLED=0` (`Dockerfile:15`) — no cgo-linked dependency is permitted.
- The Docker build **is** the test gate (`Dockerfile:22-23`): `go mod tidy && go vet ./... && go test ./...` must pass or no image is produced. **The build runs as root; a dev host does not.** Eight `internal/docker` tests call `chownTree` to a different user and therefore fail locally with `chown …: operation not permitted`. They are pre-existing and unrelated to this feature:

  ```
  TestContinuousDoesNotArmIdle          TestEnsureRunningSingleFlight
  TestCreateAddsReadOnlySecretsBind     TestReconcileEnsuresContinuousWorkspaces
  TestEnsureRunningColdStart            TestRestartWorkspaceRestartsAndRearms
  TestEnsureRunningReusesRunning        TestScaleToZeroIdleStop
  ```

  **The local gate is therefore:** `go build ./... && go vet ./... && go test ./...` with *only* those eight failing, *only* with `operation not permitted`. Every other package must be `ok`. Any additional failure, or any of those eight failing for a different reason, is a real regression. New tests must avoid the trap the way the existing ones do — construct the `Manager` with `PicoclawUser: ""`, which makes `chownTree` a no-op.
- No API response may ever contain a model `api_key`. Reads report `has_key bool` only.
- Materialized `config.json` `model_list` entries carry **no `api_key` field** — picoclaw ignores it in schema V2+ and the shipped template is `"version": 3`. Keys go to `.security.yml` at `model_list.<model_name>.api_keys` as an array, always.
- Re-materialization is stop/start only, never recreate — a recreate loses the transcript.
- All spec-driven artifacts live under `.specs/`, never at a repo root. Per-repo artifacts go in that repo's `.specs/features/model-registry-source-of-truth/`.
- Webapp conditional styling uses `class-variance-authority` variants — never inline conditional or interpolated `className`.
- Webapp tests run under `environment: "node"`; component assertions use `renderToStaticMarkup` from `react-dom/server`. Prefer testing extracted pure helpers in `lib/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Work happens on branch `feat/model-registry-source-of-truth`, which already exists in all three repos.

## Repo paths

| Shorthand | Absolute path |
|---|---|
| `PARENT` | `/mnt/external/thirdparty-projects/zombie-crab-project` |
| `PROXY` | `PARENT/crab/crab-shell-proxy` |
| `WEBAPP` | `PARENT/crab/crab-exoskeleton-webapp` |

## Phase map

| Phase | Tasks | Deliverable |
|---|---|---|
| A — registry core | T01–T06 | `internal/registry` with invariants and `Resolve`, no wiring |
| B — materialization | T07–T10 | workspaces written from the registry; old systems deleted |
| C — migration | T11–T12 | existing data imported; nothing orphaned |
| D — HTTP | T13–T15 | admin surface |
| E — gateway | T16 | routes reachable |
| F — webapp | T17–T21 | admin UI |

Phases are sequential. Within a phase, tasks are sequential unless marked `[P]`.

---

## Design correction adopted by this plan

`design.md` §2 writes `APIKey string json:"-"` on `Model` and notes "persistence uses a separate internal struct". This plan inverts that for less code and the same safety: the stored `Model` tags `APIKey` as `json:"api_key,omitempty"`, and a separate `PublicModel` wire type has no key field at all. The HTTP layer only ever marshals `PublicModel`, so leaking a key requires adding a field, not forgetting one. Update `design.md` §2 to match in T13.

---

## Phase A — Registry core

### Task 01: bbolt dependency, store skeleton, record types

**Files:**
- Create: `PROXY/internal/registry/registry.go`
- Create: `PROXY/internal/registry/registry_test.go`
- Modify: `PROXY/go.mod`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `registry.Status` (`StatusActive`/`StatusDisabled`/`StatusDeprecated` = `"active"`/`"disabled"`/`"deprecated"`)
  - `registry.Model` struct (fields per code below)
  - `registry.Assignment`, `registry.ScopeDefault`, `registry.Source` (`SourceExplicit`/`SourceInherited`)
  - `registry.WorkspaceRef` with `Key() string`
  - `registry.Open(path string, now func() time.Time) (*Registry, error)`
  - `(*Registry).Close() error`
  - `(*Registry).SchemaVersion() (int, error)`, `(*Registry).SetSchemaVersion(int) error`
  - sentinel errors `ErrNotFound`, `ErrDuplicate`, `ErrVersionConflict`, `ErrInvalid`, `ErrNoModelResolvable`
  - `registry.InUseError` with `Referrers []Referrer`, `Referrer{Kind, ID string}`

- [ ] **Step 1: Add the dependency**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
go get go.etcd.io/bbolt@v1.3.11
```

Expected: `go.mod` gains `go.etcd.io/bbolt v1.3.11` and `golang.org/x/sys` as an indirect.

- [ ] **Step 2: Write the failing test**

Create `PROXY/internal/registry/registry_test.go`:

```go
package registry

import (
	"path/filepath"
	"testing"
	"time"
)

// fixedNow keeps timestamps deterministic so tests can assert on them.
func testRegistry(t *testing.T) *Registry {
	t.Helper()
	at := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	r, err := Open(filepath.Join(t.TempDir(), "model-registry.db"), func() time.Time { return at })
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

func TestOpenCreatesBucketsAndZeroSchemaVersion(t *testing.T) {
	r := testRegistry(t)

	v, err := r.SchemaVersion()
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if v != 0 {
		t.Errorf("fresh database SchemaVersion = %d, want 0", v)
	}

	if err := r.SetSchemaVersion(1); err != nil {
		t.Fatalf("SetSchemaVersion: %v", err)
	}
	if v, err = r.SchemaVersion(); err != nil || v != 1 {
		t.Errorf("SchemaVersion after set = %d (err %v), want 1", v, err)
	}
}

func TestWorkspaceRefKeyIsSanitizedAndStable(t *testing.T) {
	a := WorkspaceRef{TenantID: "T 1", SubsAccID: "s/1", Agent: "alpha", UserAccID: "u1"}
	b := WorkspaceRef{TenantID: "T 1", SubsAccID: "s/1", Agent: "alpha", UserAccID: "u1"}
	if a.Key() != b.Key() {
		t.Errorf("Key not stable: %q vs %q", a.Key(), b.Key())
	}
	if a.Key() == "" {
		t.Error("Key must not be empty")
	}
	// A separator inside a segment must not let one ref forge another's key.
	c := WorkspaceRef{TenantID: "T 1/s", SubsAccID: "1", Agent: "alpha", UserAccID: "u1"}
	if a.Key() == c.Key() {
		t.Errorf("segment separator collision: both %q", a.Key())
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run 'TestOpen|TestWorkspaceRef' -v`
Expected: FAIL — build error, `undefined: Open`, `undefined: WorkspaceRef`.

- [ ] **Step 4: Write the implementation**

Create `PROXY/internal/registry/registry.go`:

```go
// Package registry owns the proxy-level model inventory: the single source of
// truth for which model a workspace uses. It replaces the config.yaml-backed
// override cascade and the on-disk registered-models store, which wrote the same
// workspace fields without knowing about each other.
package registry

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/identity"
)

// Status is a model's catalog lifecycle state. The two inactive states have
// opposite preconditions, which is why this is an enum and not a bool: disabled
// demands zero usage, deprecated exists precisely because usage persists.
type Status string

const (
	// StatusActive: offered; may be a scope default, an assignment or a fallback.
	StatusActive Status = "active"
	// StatusDisabled: not offered, and nothing may reference it. Reversible.
	StatusDisabled Status = "disabled"
	// StatusDeprecated: not offered to new users, but existing users keep it.
	// Requires ReplacedBy.
	StatusDeprecated Status = "deprecated"
)

// Source records why a workspace has the model it has.
type Source string

const (
	SourceExplicit  Source = "explicit"
	SourceInherited Source = "inherited"
)

// Model is one inventory record. APIKey is persisted here and never marshalled
// to a client: handlers convert to PublicModel (see public.go), so leaking a key
// requires adding a field rather than forgetting one.
type Model struct {
	ModelName  string          `json:"model_name"`
	Provider   string          `json:"provider"`
	Model      string          `json:"model"`
	APIBase    string          `json:"api_base"`
	APIKey     string          `json:"api_key,omitempty"`
	AuthMethod string          `json:"auth_method,omitempty"`
	ExtraBody  json.RawMessage `json:"extra_body,omitempty"`

	Status     Status   `json:"status"`
	ReplacedBy string   `json:"replaced_by,omitempty"`
	// Fallbacks is this model's own ordered fallback chain, by model_name. It is
	// expanded one level only when materialized, matching picoclaw's flat
	// agents.defaults.model_fallbacks.
	Fallbacks []string `json:"fallbacks,omitempty"`
	// Position orders the active list in the admin UI. It has NO functional
	// effect: reordering never re-materializes and never restarts a workspace.
	Position int `json:"position"`

	Version   uint64    `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// ImportedOrphan marks a record the boot migration recovered from a live
	// workspace because no other source declared it, for admin review.
	ImportedOrphan bool `json:"imported_orphan,omitempty"`
}

// Assignment is what a workspace actually has materialized. Chain is recorded
// alongside the primary so a key edit reaches every workspace holding the model
// as a fallback, not only those where it is primary.
type Assignment struct {
	ModelName      string    `json:"model_name"`
	Chain          []string  `json:"chain,omitempty"`
	Source         Source    `json:"source"`
	MaterializedAt time.Time `json:"materialized_at"`
}

// ScopeDefault is the model chosen at one cascade level.
type ScopeDefault struct {
	ModelName string    `json:"model_name"`
	UpdatedAt time.Time `json:"updated_at"`
}

// WorkspaceRef identifies one per-user agent workspace. The registry defines its
// own ref rather than importing docker.WorkspaceKey, which would be an import
// cycle (docker depends on registry).
type WorkspaceRef struct {
	TenantID  string
	SubsAccID string
	Agent     string
	UserAccID string
}

// Key is the assignments bucket key. Each segment is sanitized before joining so
// a separator inside an id cannot forge another workspace's key.
func (w WorkspaceRef) Key() string {
	return strings.Join([]string{
		identity.SanitizeID(w.TenantID),
		identity.SanitizeID(w.SubsAccID),
		identity.SanitizeID(w.Agent),
		identity.SanitizeID(w.UserAccID),
	}, "/")
}

var (
	// ErrNotFound: no such model / assignment / scope default.
	ErrNotFound = errors.New("registry: not found")
	// ErrDuplicate: a model with that model_name already exists.
	ErrDuplicate = errors.New("registry: model_name already exists")
	// ErrVersionConflict: the write carried a stale version.
	ErrVersionConflict = errors.New("registry: version conflict")
	// ErrInvalid: malformed input (bad status, self-referential fallback, a
	// deprecation without a valid replacement, a cycle).
	ErrInvalid = errors.New("registry: invalid")
	// ErrNoModelResolvable: no cascade level yields a model. Provisioning must
	// refuse rather than write a workspace picoclaw cannot boot.
	ErrNoModelResolvable = errors.New("registry: no model resolvable for this workspace")
)

// Referrer names one thing that keeps a model alive.
type Referrer struct {
	// Kind is "workspace" | "scope_default" | "replaced_by" | "fallback".
	Kind string `json:"kind"`
	// ID is the workspace key, scope key, or referring model_name.
	ID string `json:"id"`
}

// InUseError rejects a delete or disable and names what to detach first, so the
// admin has a concrete next action rather than a bare conflict.
type InUseError struct {
	ModelName string
	Referrers []Referrer
}

func (e *InUseError) Error() string {
	parts := make([]string, 0, len(e.Referrers))
	for _, r := range e.Referrers {
		parts = append(parts, r.Kind+":"+r.ID)
	}
	return fmt.Sprintf("registry: model %q is in use by %s", e.ModelName, strings.Join(parts, ", "))
}

var (
	bModels        = []byte("models")
	bAssignments   = []byte("assignments")
	bScopeDefaults = []byte("scope_defaults")
	bMeta          = []byte("meta")

	kSchemaVersion = []byte("schema_version")
)

// Registry is the inventory store. Every mutation runs in one bolt write
// transaction, so a check-then-write (e.g. "nobody uses this" then delete)
// cannot interleave with another admin's write.
type Registry struct {
	db  *bolt.DB
	now func() time.Time
}

// Open opens (creating if absent) the inventory database and ensures every
// bucket exists. now is injectable so tests get deterministic timestamps.
func Open(path string, now func() time.Time) (*Registry, error) {
	if now == nil {
		now = time.Now
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open model registry %s: %w", path, err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bModels, bAssignments, bScopeDefaults, bMeta} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init model registry buckets: %w", err)
	}
	return &Registry{db: db, now: now}, nil
}

func (r *Registry) Close() error { return r.db.Close() }

// SchemaVersion reports the migration marker; 0 means the boot migration has not
// run yet.
func (r *Registry) SchemaVersion() (int, error) {
	var v int
	err := r.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bMeta).Get(kSchemaVersion)
		if raw == nil {
			return nil
		}
		if len(raw) != 8 {
			return fmt.Errorf("corrupt schema_version (%d bytes)", len(raw))
		}
		v = int(binary.BigEndian.Uint64(raw))
		return nil
	})
	return v, err
}

func (r *Registry) SetSchemaVersion(v int) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		buf := make([]byte, 8)
		binary.BigEndian.PutUint64(buf, uint64(v))
		return tx.Bucket(bMeta).Put(kSchemaVersion, buf)
	})
}

// --- internal codecs, shared by every operation below ---

func putJSON(b *bolt.Bucket, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.Put([]byte(key), raw)
}

// getJSON returns ErrNotFound when the key is absent, so callers can branch on
// it instead of on a nil check they might forget.
func getJSON(b *bolt.Bucket, key string, v any) error {
	raw := b.Get([]byte(key))
	if raw == nil {
		return ErrNotFound
	}
	return json.Unmarshal(raw, v)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — both tests.

- [ ] **Step 6: Verify identity.SanitizeID exists with the expected signature**

Run: `cd PROXY && grep -n "func SanitizeID" internal/identity/*.go`
Expected: `func SanitizeID(s string) string`. If the signature differs, adapt `WorkspaceRef.Key` and re-run Step 5.

- [ ] **Step 7: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add go.mod go.sum internal/registry/
git commit -m "feat(registry): bbolt store skeleton and record types

The inventory that becomes the single source of truth for model selection.
bbolt is pure Go, which CGO_ENABLED=0 requires, and its write transaction is
what makes a check-then-write (nobody uses this, then delete) unsplittable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 02: model create / read / list / update, with uniqueness, version and fallback validation

**Files:**
- Create: `PROXY/internal/registry/models.go`
- Create: `PROXY/internal/registry/models_test.go`

**Interfaces:**
- Consumes: T01's `Model`, `Status`, `Registry`, `putJSON`/`getJSON`, `ErrDuplicate`, `ErrNotFound`, `ErrVersionConflict`, `ErrInvalid`.
- Produces:
  - `(*Registry).CreateModel(m Model) (Model, error)`
  - `(*Registry).GetModel(name string) (Model, error)`
  - `(*Registry).ListModels() ([]Model, error)` — sorted by `Position` then `ModelName`
  - `(*Registry).UpdateModel(name string, version uint64, mutate func(*Model) error) (Model, error)`
  - `(*Registry).SetPositions(order []string) error`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/registry/models_test.go`:

```go
package registry

import (
	"errors"
	"testing"
)

func mustCreate(t *testing.T, r *Registry, name string, fallbacks ...string) Model {
	t.Helper()
	m, err := r.CreateModel(Model{
		ModelName: name, Provider: "openai", Model: name,
		APIBase: "https://api.openai.com/v1", APIKey: "sk-" + name,
		Status: StatusActive, Fallbacks: fallbacks,
	})
	if err != nil {
		t.Fatalf("CreateModel(%q): %v", name, err)
	}
	return m
}

func TestCreateModelStampsVersionAndTimestamps(t *testing.T) {
	r := testRegistry(t)
	m := mustCreate(t, r, "gpt-5.4")

	if m.Version != 1 {
		t.Errorf("Version = %d, want 1", m.Version)
	}
	if m.CreatedAt.IsZero() || !m.UpdatedAt.Equal(m.CreatedAt) {
		t.Errorf("timestamps = %v / %v, want both set and equal", m.CreatedAt, m.UpdatedAt)
	}

	got, err := r.GetModel("gpt-5.4")
	if err != nil {
		t.Fatalf("GetModel: %v", err)
	}
	if got.APIKey != "sk-gpt-5.4" {
		t.Errorf("stored APIKey = %q, want the key round-tripped", got.APIKey)
	}
}

func TestCreateModelRejectsDuplicateName(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "gpt-5.4")

	// picoclaw itself permits same-named model_list entries as a round-robin
	// group; the inventory forbids them because model_name also keys
	// .security.yml, so homonyms would share one credential slot.
	_, err := r.CreateModel(Model{ModelName: "gpt-5.4", Provider: "azure", Model: "x", APIBase: "https://y", Status: StatusActive})
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate create: want ErrDuplicate, got %v", err)
	}
}

func TestCreateModelRejectsSelfFallbackAndUnknownFallback(t *testing.T) {
	r := testRegistry(t)

	_, err := r.CreateModel(Model{
		ModelName: "a", Provider: "p", Model: "a", APIBase: "https://x",
		Status: StatusActive, Fallbacks: []string{"a"},
	})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("self-fallback: want ErrInvalid, got %v", err)
	}

	_, err = r.CreateModel(Model{
		ModelName: "b", Provider: "p", Model: "b", APIBase: "https://x",
		Status: StatusActive, Fallbacks: []string{"nope"},
	})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown fallback: want ErrInvalid, got %v", err)
	}
}

func TestUpdateModelBumpsVersionAndRejectsStale(t *testing.T) {
	r := testRegistry(t)
	m := mustCreate(t, r, "gpt-5.4")

	updated, err := r.UpdateModel("gpt-5.4", m.Version, func(cur *Model) error {
		cur.APIBase = "https://proxy.internal/v1"
		return nil
	})
	if err != nil {
		t.Fatalf("UpdateModel: %v", err)
	}
	if updated.Version != 2 || updated.APIBase != "https://proxy.internal/v1" {
		t.Errorf("updated = version %d base %q, want 2 and the new base", updated.Version, updated.APIBase)
	}

	// The stale version must be rejected AND nothing written.
	_, err = r.UpdateModel("gpt-5.4", m.Version, func(cur *Model) error {
		cur.APIBase = "https://clobber"
		return nil
	})
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale update: want ErrVersionConflict, got %v", err)
	}
	after, _ := r.GetModel("gpt-5.4")
	if after.APIBase != "https://proxy.internal/v1" {
		t.Errorf("rejected update still wrote: base = %q", after.APIBase)
	}
}

func TestUpdateModelKeepsKeyWhenMutatorLeavesItAlone(t *testing.T) {
	r := testRegistry(t)
	m := mustCreate(t, r, "gpt-5.4")

	if _, err := r.UpdateModel("gpt-5.4", m.Version, func(cur *Model) error {
		cur.Provider = "azure"
		return nil
	}); err != nil {
		t.Fatalf("UpdateModel: %v", err)
	}
	got, _ := r.GetModel("gpt-5.4")
	if got.APIKey != "sk-gpt-5.4" {
		t.Errorf("APIKey lost on unrelated update: %q", got.APIKey)
	}
}

func TestListModelsSortsByPositionThenName(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "c")
	mustCreate(t, r, "a")
	mustCreate(t, r, "b")

	if err := r.SetPositions([]string{"b", "a", "c"}); err != nil {
		t.Fatalf("SetPositions: %v", err)
	}
	got, err := r.ListModels()
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	names := []string{got[0].ModelName, got[1].ModelName, got[2].ModelName}
	if names[0] != "b" || names[1] != "a" || names[2] != "c" {
		t.Errorf("order = %v, want [b a c]", names)
	}
}

func TestSetPositionsDoesNotBumpVersion(t *testing.T) {
	r := testRegistry(t)
	m := mustCreate(t, r, "a")
	mustCreate(t, r, "b")

	if err := r.SetPositions([]string{"b", "a"}); err != nil {
		t.Fatalf("SetPositions: %v", err)
	}
	got, _ := r.GetModel("a")
	// Position is presentation only. Bumping Version would make a harmless drag
	// invalidate every open edit form with a spurious 409.
	if got.Version != m.Version {
		t.Errorf("Version = %d after reorder, want %d unchanged", got.Version, m.Version)
	}
}

func TestGetModelUnknownIsNotFound(t *testing.T) {
	r := testRegistry(t)
	if _, err := r.GetModel("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run TestCreateModel -v`
Expected: FAIL — `r.CreateModel undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/registry/models.go`:

```go
package registry

import (
	"fmt"
	"sort"

	bolt "go.etcd.io/bbolt"
)

// validateStatus rejects an unknown status before it reaches the store, where a
// typo would silently make a model neither offered nor retired.
func validateStatus(s Status) error {
	switch s {
	case StatusActive, StatusDisabled, StatusDeprecated:
		return nil
	}
	return fmt.Errorf("%w: unknown status %q", ErrInvalid, s)
}

// validateFallbacks enforces I8: every name exists and no model lists itself.
// Existence is checked inside the caller's transaction so a concurrent delete
// cannot slip a dangling name in.
func validateFallbacks(b *bolt.Bucket, self string, fallbacks []string) error {
	seen := map[string]bool{}
	for _, name := range fallbacks {
		if name == self {
			return fmt.Errorf("%w: model %q cannot fall back to itself", ErrInvalid, self)
		}
		if seen[name] {
			return fmt.Errorf("%w: duplicate fallback %q", ErrInvalid, name)
		}
		seen[name] = true
		if b.Get([]byte(name)) == nil {
			return fmt.Errorf("%w: fallback %q does not exist", ErrInvalid, name)
		}
	}
	return nil
}

// requiredFields rejects a record that could not produce a bootable workspace.
// api_base is optional only when auth_method is set (e.g. the antigravity oauth
// entry in the suggestion catalog ships without one).
func requiredFields(m Model) error {
	switch {
	case m.ModelName == "":
		return fmt.Errorf("%w: model_name is required", ErrInvalid)
	case m.Provider == "":
		return fmt.Errorf("%w: provider is required", ErrInvalid)
	case m.Model == "":
		return fmt.Errorf("%w: model is required", ErrInvalid)
	case m.APIBase == "" && m.AuthMethod == "":
		return fmt.Errorf("%w: api_base is required unless auth_method is set", ErrInvalid)
	}
	return nil
}

// CreateModel inserts a new model. Position defaults to the end of the list so a
// new entry never silently displaces an existing one.
func (r *Registry) CreateModel(m Model) (Model, error) {
	if err := requiredFields(m); err != nil {
		return Model{}, err
	}
	if m.Status == "" {
		m.Status = StatusActive
	}
	if err := validateStatus(m.Status); err != nil {
		return Model{}, err
	}
	if m.Status == StatusDeprecated {
		return Model{}, fmt.Errorf("%w: create a model active or disabled, then deprecate it", ErrInvalid)
	}
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		if b.Get([]byte(m.ModelName)) != nil {
			return fmt.Errorf("%w: %q", ErrDuplicate, m.ModelName)
		}
		if err := validateFallbacks(b, m.ModelName, m.Fallbacks); err != nil {
			return err
		}
		if m.Position == 0 {
			m.Position = b.Stats().KeyN + 1
		}
		at := r.now()
		m.Version = 1
		m.CreatedAt = at
		m.UpdatedAt = at
		out = m
		return putJSON(b, m.ModelName, m)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}

// GetModel returns one record, key included. Callers that answer a client must
// convert to PublicModel first.
func (r *Registry) GetModel(name string) (Model, error) {
	var m Model
	err := r.db.View(func(tx *bolt.Tx) error {
		return getJSON(tx.Bucket(bModels), name, &m)
	})
	if err != nil {
		return Model{}, err
	}
	return m, nil
}

// ListModels returns every record in display order: Position, then model_name as
// a stable tiebreak so an unordered inventory still lists deterministically.
func (r *Registry) ListModels() ([]Model, error) {
	var out []Model
	err := r.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bModels).ForEach(func(_, raw []byte) error {
			var m Model
			if err := jsonUnmarshal(raw, &m); err != nil {
				return err
			}
			out = append(out, m)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Position != out[j].Position {
			return out[i].Position < out[j].Position
		}
		return out[i].ModelName < out[j].ModelName
	})
	return out, nil
}

// UpdateModel read-modify-writes one record under an optimistic version check.
// The mutator receives the stored record (key included) so an edit that does not
// mention the key keeps it.
func (r *Registry) UpdateModel(name string, version uint64, mutate func(*Model) error) (Model, error) {
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		var cur Model
		if err := getJSON(b, name, &cur); err != nil {
			return err
		}
		if cur.Version != version {
			return fmt.Errorf("%w: stored version %d, write carried %d", ErrVersionConflict, cur.Version, version)
		}
		if err := mutate(&cur); err != nil {
			return err
		}
		if cur.ModelName != name {
			return fmt.Errorf("%w: model_name is the key and cannot be changed", ErrInvalid)
		}
		if err := requiredFields(cur); err != nil {
			return err
		}
		if err := validateStatus(cur.Status); err != nil {
			return err
		}
		if err := validateFallbacks(b, cur.ModelName, cur.Fallbacks); err != nil {
			return err
		}
		cur.Version++
		cur.UpdatedAt = r.now()
		out = cur
		return putJSON(b, name, cur)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}

// SetPositions rewrites display order. It deliberately does NOT bump Version:
// position is presentation only, and bumping it would make a harmless drag
// invalidate every open edit form with a spurious 409.
func (r *Registry) SetPositions(order []string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		for i, name := range order {
			var m Model
			if err := getJSON(b, name, &m); err != nil {
				return fmt.Errorf("reorder %q: %w", name, err)
			}
			m.Position = i + 1
			if err := putJSON(b, name, m); err != nil {
				return err
			}
		}
		return nil
	})
}
```

- [ ] **Step 4: Add the shared unmarshal helper used by ListModels**

Append to `PROXY/internal/registry/registry.go`:

```go
// jsonUnmarshal exists so bucket scans (which hold raw bytes, not a key) share
// one decode path with getJSON.
func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — all T01 and T02 tests.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/
git commit -m "feat(registry): model CRUD with uniqueness, optimistic version, fallback validation

model_name uniqueness (I1) is what keeps one credential slot per model: it also
keys .security.yml, so homonyms would share a key. SetPositions deliberately
does not bump Version — position is presentation only, and bumping it would turn
a harmless reorder into a spurious 409 on every open form.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 03: referrers, delete and disable gating

**Files:**
- Create: `PROXY/internal/registry/referrers.go`
- Create: `PROXY/internal/registry/referrers_test.go`
- Modify: `PROXY/internal/registry/models.go` (add `DeleteModel`, `SetStatus`)

**Interfaces:**
- Consumes: T01 `Referrer`, `InUseError`, buckets; T02 `CreateModel`, `GetModel`, `UpdateModel`.
- Produces:
  - `(*Registry).Referrers(name string) ([]Referrer, error)`
  - `(*Registry).DeleteModel(name string) error`
  - `(*Registry).SetStatus(name string, version uint64, status Status, replacedBy string) (Model, error)` — deprecation validation lands in T04; this task implements `active`/`disabled` only and returns `ErrInvalid` for `deprecated`.
  - `(*Registry).PutAssignment(ref WorkspaceRef, a Assignment) error`
  - `(*Registry).GetAssignment(ref WorkspaceRef) (Assignment, error)`
  - `(*Registry).PutScopeDefault(scopeKey string, d ScopeDefault) error`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/registry/referrers_test.go`:

```go
package registry

import (
	"errors"
	"testing"
)

func TestReferrersFindsAllFourKinds(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "target")
	mustCreate(t, r, "primary", "target") // fallback referrer
	mustCreate(t, r, "successor")

	ref := WorkspaceRef{TenantID: "t", SubsAccID: "s", Agent: "alpha", UserAccID: "u"}
	if err := r.PutAssignment(ref, Assignment{ModelName: "target", Source: SourceInherited}); err != nil {
		t.Fatalf("PutAssignment: %v", err)
	}
	if err := r.PutScopeDefault("tenant/t", ScopeDefault{ModelName: "target"}); err != nil {
		t.Fatalf("PutScopeDefault: %v", err)
	}
	// successor -> deprecated placeholder pointing at target via replaced_by.
	if _, err := r.UpdateModelRaw("successor", func(m *Model) error {
		m.Status = StatusDeprecated
		m.ReplacedBy = "target"
		return nil
	}); err != nil {
		t.Fatalf("seed replaced_by: %v", err)
	}

	got, err := r.Referrers("target")
	if err != nil {
		t.Fatalf("Referrers: %v", err)
	}
	kinds := map[string]bool{}
	for _, rr := range got {
		kinds[rr.Kind] = true
	}
	for _, want := range []string{"workspace", "scope_default", "replaced_by", "fallback"} {
		if !kinds[want] {
			t.Errorf("missing referrer kind %q in %+v", want, got)
		}
	}
}

func TestReferrersCountsChainMembership(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "fb")
	mustCreate(t, r, "main", "fb")

	ref := WorkspaceRef{TenantID: "t", SubsAccID: "s", Agent: "alpha", UserAccID: "u"}
	if err := r.PutAssignment(ref, Assignment{ModelName: "main", Chain: []string{"fb"}, Source: SourceInherited}); err != nil {
		t.Fatalf("PutAssignment: %v", err)
	}

	// A workspace holding "fb" only as a fallback still counts as a workspace
	// referrer: it has fb's key on disk and names it in model_fallbacks.
	got, err := r.Referrers("fb")
	if err != nil {
		t.Fatalf("Referrers: %v", err)
	}
	var ws int
	for _, rr := range got {
		if rr.Kind == "workspace" {
			ws++
		}
	}
	if ws != 1 {
		t.Errorf("workspace referrers via chain = %d, want 1 (%+v)", ws, got)
	}
}

func TestDeleteModelBlockedWhileReferencedThenAllowedAfterDetach(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "fb")
	main := mustCreate(t, r, "main", "fb")

	var inUse *InUseError
	err := r.DeleteModel("fb")
	if !errors.As(err, &inUse) {
		t.Fatalf("delete referenced: want *InUseError, got %v", err)
	}
	if len(inUse.Referrers) == 0 || inUse.Referrers[0].Kind != "fallback" {
		t.Errorf("referrers should name the fallback holder: %+v", inUse.Referrers)
	}
	if _, err := r.GetModel("fb"); err != nil {
		t.Errorf("rejected delete still removed the record: %v", err)
	}

	// Detaching is the concrete action the rejection points at.
	if _, err := r.UpdateModel("main", main.Version, func(m *Model) error {
		m.Fallbacks = nil
		return nil
	}); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if err := r.DeleteModel("fb"); err != nil {
		t.Fatalf("delete after detach: %v", err)
	}
	if _, err := r.GetModel("fb"); !errors.Is(err, ErrNotFound) {
		t.Errorf("model still present after delete: %v", err)
	}
}

func TestSetStatusDisabledSharesTheDeletePrecondition(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "fb")
	mustCreate(t, r, "main", "fb")
	fb, _ := r.GetModel("fb")

	var inUse *InUseError
	_, err := r.SetStatus("fb", fb.Version, StatusDisabled, "")
	if !errors.As(err, &inUse) {
		t.Fatalf("disable referenced: want *InUseError, got %v", err)
	}
	after, _ := r.GetModel("fb")
	if after.Status != StatusActive {
		t.Errorf("rejected disable still wrote: status = %q", after.Status)
	}
}

func TestSetStatusDisableAndReactivateUnreferencedModel(t *testing.T) {
	r := testRegistry(t)
	m := mustCreate(t, r, "shelf")

	off, err := r.SetStatus("shelf", m.Version, StatusDisabled, "")
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if off.Status != StatusDisabled {
		t.Errorf("status = %q, want disabled", off.Status)
	}
	back, err := r.SetStatus("shelf", off.Version, StatusActive, "")
	if err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	if back.Status != StatusActive || back.Position != m.Position {
		t.Errorf("reactivated = status %q position %d, want active and position %d preserved",
			back.Status, back.Position, m.Position)
	}
}

func TestDeleteUnknownModelIsNotFound(t *testing.T) {
	r := testRegistry(t)
	if err := r.DeleteModel("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run 'TestReferrers|TestDelete|TestSetStatus' -v`
Expected: FAIL — `r.Referrers undefined`, `r.PutAssignment undefined`, `r.UpdateModelRaw undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/registry/referrers.go`:

```go
package registry

import (
	"sort"

	bolt "go.etcd.io/bbolt"
)

// referrersTx collects everything keeping name alive. It runs inside the
// caller's transaction so the check cannot be split from the write it guards.
//
// A full scan of three buckets beats maintaining reverse indexes here: the
// inventory holds tens of models and hundreds of workspaces, and a scan cannot
// drift out of sync with the data it derives from.
func referrersTx(tx *bolt.Tx, name string) ([]Referrer, error) {
	var out []Referrer

	err := tx.Bucket(bAssignments).ForEach(func(k, raw []byte) error {
		var a Assignment
		if err := jsonUnmarshal(raw, &a); err != nil {
			return err
		}
		// Chain membership counts: that workspace has this model's key on disk
		// and names it in agents.defaults.model_fallbacks.
		if a.ModelName == name || contains(a.Chain, name) {
			out = append(out, Referrer{Kind: "workspace", ID: string(k)})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	err = tx.Bucket(bScopeDefaults).ForEach(func(k, raw []byte) error {
		var d ScopeDefault
		if err := jsonUnmarshal(raw, &d); err != nil {
			return err
		}
		if d.ModelName == name {
			out = append(out, Referrer{Kind: "scope_default", ID: string(k)})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	err = tx.Bucket(bModels).ForEach(func(k, raw []byte) error {
		if string(k) == name {
			return nil
		}
		var m Model
		if err := jsonUnmarshal(raw, &m); err != nil {
			return err
		}
		if m.ReplacedBy == name {
			out = append(out, Referrer{Kind: "replaced_by", ID: m.ModelName})
		}
		if contains(m.Fallbacks, name) {
			out = append(out, Referrer{Kind: "fallback", ID: m.ModelName})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// Referrers reports everything that keeps a model alive, for the admin UI's
// usage count and for the detail an in-use rejection carries.
func (r *Registry) Referrers(name string) ([]Referrer, error) {
	var out []Referrer
	err := r.db.View(func(tx *bolt.Tx) error {
		var err error
		out, err = referrersTx(tx, name)
		return err
	})
	return out, err
}

// PutAssignment records what a workspace has materialized.
func (r *Registry) PutAssignment(ref WorkspaceRef, a Assignment) error {
	if a.MaterializedAt.IsZero() {
		a.MaterializedAt = r.now()
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bAssignments), ref.Key(), a)
	})
}

// GetAssignment returns ErrNotFound when the workspace has never been
// materialized — which is exactly the condition the deprecation hop keys on.
func (r *Registry) GetAssignment(ref WorkspaceRef) (Assignment, error) {
	var a Assignment
	err := r.db.View(func(tx *bolt.Tx) error {
		return getJSON(tx.Bucket(bAssignments), ref.Key(), &a)
	})
	if err != nil {
		return Assignment{}, err
	}
	return a, nil
}

// DeleteAssignment removes a workspace's record (idempotent), for a workspace
// that has been torn down.
func (r *Registry) DeleteAssignment(ref WorkspaceRef) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bAssignments).Delete([]byte(ref.Key()))
	})
}

// PutScopeDefault sets the model chosen at one cascade level. The caller
// validates the model exists and is active.
func (r *Registry) PutScopeDefault(scopeKey string, d ScopeDefault) error {
	if d.UpdatedAt.IsZero() {
		d.UpdatedAt = r.now()
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bScopeDefaults), scopeKey, d)
	})
}
```

- [ ] **Step 4: Add DeleteModel, SetStatus and the test-only UpdateModelRaw**

Append to `PROXY/internal/registry/models.go`:

```go
// DeleteModel removes a model, rejecting the delete while anything references it
// (I2). The rejection names the referrers so the admin knows what to detach.
func (r *Registry) DeleteModel(name string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		if b.Get([]byte(name)) == nil {
			return ErrNotFound
		}
		refs, err := referrersTx(tx, name)
		if err != nil {
			return err
		}
		if len(refs) > 0 {
			return &InUseError{ModelName: name, Referrers: refs}
		}
		return b.Delete([]byte(name))
	})
}

// SetStatus transitions a model's lifecycle state under the same optimistic
// version check as an edit.
//
//   - -> disabled carries DeleteModel's precondition (I3): a model nothing uses
//     can be shelved; one in use must be deprecated instead.
//   - -> active clears ReplacedBy and preserves Position, so reactivating
//     restores a model's place rather than appending it.
//   - -> deprecated is rejected here; T04 adds it with its replacement rules.
func (r *Registry) SetStatus(name string, version uint64, status Status, replacedBy string) (Model, error) {
	if err := validateStatus(status); err != nil {
		return Model{}, err
	}
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		var cur Model
		if err := getJSON(b, name, &cur); err != nil {
			return err
		}
		if cur.Version != version {
			return fmt.Errorf("%w: stored version %d, write carried %d", ErrVersionConflict, cur.Version, version)
		}
		switch status {
		case StatusDisabled:
			refs, err := referrersTx(tx, name)
			if err != nil {
				return err
			}
			if len(refs) > 0 {
				return &InUseError{ModelName: name, Referrers: refs}
			}
			cur.ReplacedBy = ""
		case StatusActive:
			cur.ReplacedBy = ""
		case StatusDeprecated:
			return fmt.Errorf("%w: use Deprecate to retire a model", ErrInvalid)
		}
		cur.Status = status
		cur.Version++
		cur.UpdatedAt = r.now()
		out = cur
		return putJSON(b, name, cur)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}

// UpdateModelRaw mutates a record without the version check. It exists for the
// boot migration and for tests seeding states the public API refuses to create
// directly. Never call it from an HTTP handler.
func (r *Registry) UpdateModelRaw(name string, mutate func(*Model) error) (Model, error) {
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		var cur Model
		if err := getJSON(b, name, &cur); err != nil {
			return err
		}
		if err := mutate(&cur); err != nil {
			return err
		}
		cur.Version++
		cur.UpdatedAt = r.now()
		out = cur
		return putJSON(b, name, cur)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — all tests through T03.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/
git commit -m "feat(registry): referrers, in-use gating for delete and disable

I2/I3 are satisfiable precisely because chains are DECLARED rather than derived
from the active set: detaching a model from the one or two fallback lists naming
it is a concrete action the 409 points at. Chain membership counts as workspace
use because such a workspace holds the model's key on disk and names it in
agents.defaults.model_fallbacks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 04: deprecation with a required replacement, cycle-free

**Files:**
- Create: `PROXY/internal/registry/deprecate.go`
- Create: `PROXY/internal/registry/deprecate_test.go`

**Interfaces:**
- Consumes: T01–T03.
- Produces:
  - `(*Registry).Deprecate(name string, version uint64, replacedBy string) (Model, error)`
  - `(*Registry).ResolveReplacement(name string) (Model, error)` — follows `replaced_by` to the first non-deprecated model, max 8 hops, cycle-detected.
  - `maxDeprecationHops = 8`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/registry/deprecate_test.go`:

```go
package registry

import (
	"errors"
	"strings"
	"testing"
)

func TestDeprecateRequiresAnExistingActiveReplacement(t *testing.T) {
	r := testRegistry(t)
	old := mustCreate(t, r, "old")

	// No replacement at all.
	if _, err := r.Deprecate("old", old.Version, ""); !errors.Is(err, ErrInvalid) {
		t.Errorf("no replacement: want ErrInvalid, got %v", err)
	}
	// A replacement that does not exist.
	if _, err := r.Deprecate("old", old.Version, "ghost"); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown replacement: want ErrInvalid, got %v", err)
	}
	// A replacement that exists but is disabled — it could not serve anyone.
	shelf := mustCreate(t, r, "shelf")
	if _, err := r.SetStatus("shelf", shelf.Version, StatusDisabled, ""); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := r.Deprecate("old", old.Version, "shelf"); !errors.Is(err, ErrInvalid) {
		t.Errorf("disabled replacement: want ErrInvalid, got %v", err)
	}
	// Itself.
	if _, err := r.Deprecate("old", old.Version, "old"); !errors.Is(err, ErrInvalid) {
		t.Errorf("self replacement: want ErrInvalid, got %v", err)
	}

	after, _ := r.GetModel("old")
	if after.Status != StatusActive || after.ReplacedBy != "" {
		t.Errorf("rejected deprecations still wrote: %+v", after)
	}
}

func TestDeprecateSucceedsAndRecordsTheReplacement(t *testing.T) {
	r := testRegistry(t)
	old := mustCreate(t, r, "old")
	mustCreate(t, r, "new")

	got, err := r.Deprecate("old", old.Version, "new")
	if err != nil {
		t.Fatalf("Deprecate: %v", err)
	}
	if got.Status != StatusDeprecated || got.ReplacedBy != "new" {
		t.Errorf("deprecated = %+v, want status deprecated replaced_by new", got)
	}
	if got.Version != old.Version+1 {
		t.Errorf("Version = %d, want %d", got.Version, old.Version+1)
	}
}

func TestDeprecateRejectsACycle(t *testing.T) {
	r := testRegistry(t)
	a := mustCreate(t, r, "a")
	b := mustCreate(t, r, "b")

	// a -> b is fine while b is active.
	if _, err := r.Deprecate("a", a.Version, "b"); err != nil {
		t.Fatalf("first deprecate: %v", err)
	}
	// b -> a would close a loop: a is deprecated pointing at b.
	if _, err := r.Deprecate("b", b.Version, "a"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cycle: want ErrInvalid, got %v", err)
	}
	after, _ := r.GetModel("b")
	if after.Status != StatusActive {
		t.Errorf("rejected cycle still wrote: %+v", after)
	}
}

func TestResolveReplacementWalksTheChainToAnActiveModel(t *testing.T) {
	r := testRegistry(t)
	v1 := mustCreate(t, r, "v1")
	v2 := mustCreate(t, r, "v2")
	mustCreate(t, r, "v3")

	if _, err := r.Deprecate("v2", v2.Version, "v3"); err != nil {
		t.Fatalf("deprecate v2: %v", err)
	}
	if _, err := r.Deprecate("v1", v1.Version, "v2"); err != nil {
		t.Fatalf("deprecate v1: %v", err)
	}

	got, err := r.ResolveReplacement("v1")
	if err != nil {
		t.Fatalf("ResolveReplacement: %v", err)
	}
	if got.ModelName != "v3" {
		t.Errorf("resolved = %q, want v3 (v1 -> v2 -> v3)", got.ModelName)
	}
}

func TestResolveReplacementBoundsTheHopCount(t *testing.T) {
	r := testRegistry(t)
	// Build a chain longer than the bound using the raw mutator, which skips the
	// cycle check the public API enforces — this asserts the traversal itself is
	// bounded and does not rely on write-time validation alone.
	names := []string{"m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"}
	for _, n := range names {
		mustCreate(t, r, n)
	}
	for i := 0; i < len(names)-1; i++ {
		next := names[i+1]
		if _, err := r.UpdateModelRaw(names[i], func(m *Model) error {
			m.Status = StatusDeprecated
			m.ReplacedBy = next
			return nil
		}); err != nil {
			t.Fatalf("seed chain: %v", err)
		}
	}

	_, err := r.ResolveReplacement("m0")
	if err == nil || !strings.Contains(err.Error(), "chain") {
		t.Fatalf("want a bounded-chain error, got %v", err)
	}
}

func TestResolveReplacementOnANonDeprecatedModelReturnsItself(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "fine")

	got, err := r.ResolveReplacement("fine")
	if err != nil {
		t.Fatalf("ResolveReplacement: %v", err)
	}
	if got.ModelName != "fine" {
		t.Errorf("resolved = %q, want fine", got.ModelName)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run 'TestDeprecate|TestResolveReplacement' -v`
Expected: FAIL — `r.Deprecate undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/registry/deprecate.go`:

```go
package registry

import (
	"fmt"

	bolt "go.etcd.io/bbolt"
)

// maxDeprecationHops bounds a replacement walk. A chain longer than this is a
// configuration mistake, and an unbounded walk over corrupt data would hang the
// resolver on every provision.
const maxDeprecationHops = 8

// Deprecate retires a model that may still be in use: existing workspaces keep
// it, while new ones get replacedBy. That is the only way to retire something in
// use — disable requires zero usage (I3).
//
// Enforces I4 (the replacement must exist and must not be disabled — a
// deprecated one is a valid chain link) and I5 (no cycles).
func (r *Registry) Deprecate(name string, version uint64, replacedBy string) (Model, error) {
	if replacedBy == "" {
		return Model{}, fmt.Errorf("%w: deprecating %q requires a replacement so new users have somewhere to go", ErrInvalid, name)
	}
	if replacedBy == name {
		return Model{}, fmt.Errorf("%w: %q cannot replace itself", ErrInvalid, name)
	}
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		var cur Model
		if err := getJSON(b, name, &cur); err != nil {
			return err
		}
		if cur.Version != version {
			return fmt.Errorf("%w: stored version %d, write carried %d", ErrVersionConflict, cur.Version, version)
		}
		var repl Model
		if err := getJSON(b, replacedBy, &repl); err != nil {
			if err == ErrNotFound {
				return fmt.Errorf("%w: replacement %q does not exist", ErrInvalid, replacedBy)
			}
			return err
		}
		// Only DISABLED is rejected. A deprecated replacement is a legitimate chain
		// link — resolution hops onward from it until it reaches something active —
		// and requiring active here would make it impossible to retire a series of
		// models incrementally, since each new retirement would have to re-point
		// every predecessor.
		if repl.Status == StatusDisabled {
			return fmt.Errorf("%w: replacement %q is disabled, so it could not serve new users", ErrInvalid, replacedBy)
		}
		// Walk forward from the replacement: if it leads back to name, this write
		// would close a loop and strand every workspace that resolves through it.
		if err := assertNoCycleTx(tx, replacedBy, name); err != nil {
			return err
		}
		cur.Status = StatusDeprecated
		cur.ReplacedBy = replacedBy
		cur.Version++
		cur.UpdatedAt = r.now()
		out = cur
		return putJSON(b, name, cur)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}

// assertNoCycleTx walks replaced_by from start and fails if it reaches forbidden
// or revisits a node.
func assertNoCycleTx(tx *bolt.Tx, start, forbidden string) error {
	b := tx.Bucket(bModels)
	seen := map[string]bool{}
	cursor := start
	for hop := 0; hop < maxDeprecationHops; hop++ {
		if cursor == forbidden {
			return fmt.Errorf("%w: that would create a deprecation cycle through %q", ErrInvalid, forbidden)
		}
		if seen[cursor] {
			return fmt.Errorf("%w: deprecation chain already loops at %q", ErrInvalid, cursor)
		}
		seen[cursor] = true
		var m Model
		if err := getJSON(b, cursor, &m); err != nil {
			return nil // a dangling tail cannot form a cycle
		}
		if m.Status != StatusDeprecated || m.ReplacedBy == "" {
			return nil
		}
		cursor = m.ReplacedBy
	}
	return fmt.Errorf("%w: deprecation chain from %q exceeds %d hops", ErrInvalid, start, maxDeprecationHops)
}

// ResolveReplacement follows replaced_by until it reaches a model that is not
// deprecated, and returns that. A model that is not deprecated resolves to
// itself, so callers can call this unconditionally.
func (r *Registry) ResolveReplacement(name string) (Model, error) {
	var out Model
	err := r.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		seen := map[string]bool{}
		cursor := name
		for hop := 0; hop <= maxDeprecationHops; hop++ {
			if seen[cursor] {
				return fmt.Errorf("%w: deprecation chain loops at %q", ErrInvalid, cursor)
			}
			seen[cursor] = true
			var m Model
			if err := getJSON(b, cursor, &m); err != nil {
				return fmt.Errorf("deprecation chain from %q: %q: %w", name, cursor, err)
			}
			if m.Status != StatusDeprecated || m.ReplacedBy == "" {
				out = m
				return nil
			}
			cursor = m.ReplacedBy
		}
		return fmt.Errorf("%w: deprecation chain from %q exceeds %d hops", ErrInvalid, name, maxDeprecationHops)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — all tests through T04.

- [ ] **Step 5: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/
git commit -m "feat(registry): deprecation with a required active replacement, cycle-free

Deprecation is the only way to retire a model that is in use: disable demands
zero usage. Requiring a replacement is what lets new users land somewhere while
existing users keep the old model. Both the write-time cycle check and the
traversal are bounded, so corrupt data cannot hang a provision.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 05: scope defaults and the cascade key vocabulary

**Files:**
- Create: `PROXY/internal/registry/scopes.go`
- Create: `PROXY/internal/registry/scopes_test.go`
- Modify: `PROXY/internal/registry/referrers.go` (drop the interim `PutScopeDefault`, superseded here)

**Interfaces:**
- Consumes: T01–T04.
- Produces:
  - `registry.ScopeLevel` (`LevelGlobal`, `LevelAgent`, `LevelTenant`, `LevelSubscription`, `LevelUser` = `"global"`, `"agent"`, `"tenant"`, `"subscription"`, `"user"`)
  - `registry.ScopeSel{Level ScopeLevel; Agent, TenantID, SubsAccID string}` with `Key() (string, error)`
  - `(*Registry).SetScopeDefault(sel ScopeSel, modelName string) error` — validates the model exists and is active
  - `(*Registry).GetScopeDefault(sel ScopeSel) (ScopeDefault, error)`
  - `(*Registry).ClearScopeDefault(sel ScopeSel) error`
  - `(*Registry).ListScopeDefaults() (map[string]ScopeDefault, error)`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/registry/scopes_test.go`:

```go
package registry

import (
	"errors"
	"testing"
)

func TestScopeSelKeyShapes(t *testing.T) {
	cases := []struct {
		name string
		sel  ScopeSel
		want string
	}{
		{"global", ScopeSel{Level: LevelGlobal}, "global"},
		{"agent", ScopeSel{Level: LevelAgent, Agent: "alpha"}, "agent/alpha"},
		{"tenant", ScopeSel{Level: LevelTenant, TenantID: "t1"}, "tenant/t1"},
		{"subscription", ScopeSel{Level: LevelSubscription, TenantID: "t1", SubsAccID: "s1"}, "subs/t1/s1"},
	}
	for _, c := range cases {
		got, err := c.sel.Key()
		if err != nil {
			t.Errorf("%s: Key: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: Key = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestScopeSelKeyRejectsMissingIdentifiers(t *testing.T) {
	bad := []ScopeSel{
		{Level: LevelAgent},
		{Level: LevelTenant},
		{Level: LevelSubscription, TenantID: "t1"},
		{Level: "nonsense"},
		{Level: LevelUser, TenantID: "t1", SubsAccID: "s1"},
	}
	for _, sel := range bad {
		if _, err := sel.Key(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: want ErrInvalid, got %v", sel, err)
		}
	}
}

func TestSetScopeDefaultRequiresAnActiveModel(t *testing.T) {
	r := testRegistry(t)
	sel := ScopeSel{Level: LevelTenant, TenantID: "t1"}

	if err := r.SetScopeDefault(sel, "ghost"); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown model: want ErrInvalid, got %v", err)
	}

	shelf := mustCreate(t, r, "shelf")
	if _, err := r.SetStatus("shelf", shelf.Version, StatusDisabled, ""); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if err := r.SetScopeDefault(sel, "shelf"); !errors.Is(err, ErrInvalid) {
		t.Errorf("disabled model: want ErrInvalid, got %v", err)
	}

	mustCreate(t, r, "good")
	if err := r.SetScopeDefault(sel, "good"); err != nil {
		t.Fatalf("SetScopeDefault: %v", err)
	}
	got, err := r.GetScopeDefault(sel)
	if err != nil || got.ModelName != "good" {
		t.Errorf("GetScopeDefault = %+v (err %v), want good", got, err)
	}
}

func TestSetScopeDefaultAcceptsADeprecatedModelSoRetirementIsNotBlocked(t *testing.T) {
	r := testRegistry(t)
	old := mustCreate(t, r, "old")
	mustCreate(t, r, "new")
	sel := ScopeSel{Level: LevelTenant, TenantID: "t1"}
	if err := r.SetScopeDefault(sel, "old"); err != nil {
		t.Fatalf("seed default: %v", err)
	}

	// Deprecating a model that IS a scope default must stay possible: that is the
	// normal retirement path, and the resolver hops to the replacement for new
	// users without the admin having to re-point every scope first.
	if _, err := r.Deprecate("old", old.Version, "new"); err != nil {
		t.Fatalf("Deprecate a scope default: %v", err)
	}
}

func TestClearAndListScopeDefaults(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "m")
	tenant := ScopeSel{Level: LevelTenant, TenantID: "t1"}
	subs := ScopeSel{Level: LevelSubscription, TenantID: "t1", SubsAccID: "s1"}
	if err := r.SetScopeDefault(tenant, "m"); err != nil {
		t.Fatal(err)
	}
	if err := r.SetScopeDefault(subs, "m"); err != nil {
		t.Fatal(err)
	}

	all, err := r.ListScopeDefaults()
	if err != nil {
		t.Fatalf("ListScopeDefaults: %v", err)
	}
	if len(all) != 2 || all["tenant/t1"].ModelName != "m" || all["subs/t1/s1"].ModelName != "m" {
		t.Errorf("listed = %+v, want both keys", all)
	}

	if err := r.ClearScopeDefault(tenant); err != nil {
		t.Fatalf("ClearScopeDefault: %v", err)
	}
	if _, err := r.GetScopeDefault(tenant); !errors.Is(err, ErrNotFound) {
		t.Errorf("cleared default still present: %v", err)
	}
	// Clearing twice is a success — the admin's intent is already true.
	if err := r.ClearScopeDefault(tenant); err != nil {
		t.Errorf("second clear should be idempotent, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run TestScope -v`
Expected: FAIL — `undefined: ScopeSel`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/registry/scopes.go`:

```go
package registry

import (
	"fmt"

	bolt "go.etcd.io/bbolt"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/identity"
)

// ScopeLevel names one rung of the resolution cascade.
type ScopeLevel string

const (
	LevelGlobal       ScopeLevel = "global"
	LevelAgent        ScopeLevel = "agent"
	LevelTenant       ScopeLevel = "tenant"
	LevelSubscription ScopeLevel = "subscription"
	// LevelUser is reported by Resolve as the winning level. It is never a
	// scope-defaults key: a per-user choice is an assignment, not a default.
	LevelUser ScopeLevel = "user"
)

// ScopeSel identifies one scope-defaults entry.
type ScopeSel struct {
	Level     ScopeLevel
	Agent     string
	TenantID  string
	SubsAccID string
}

// Key is the scope_defaults bucket key. Ids are sanitized so they cannot contain
// the separator and forge another scope's key.
func (s ScopeSel) Key() (string, error) {
	switch s.Level {
	case LevelGlobal:
		return "global", nil
	case LevelAgent:
		if s.Agent == "" {
			return "", fmt.Errorf("%w: an agent scope needs an agent", ErrInvalid)
		}
		return "agent/" + identity.SanitizeID(s.Agent), nil
	case LevelTenant:
		if s.TenantID == "" {
			return "", fmt.Errorf("%w: a tenant scope needs a tenant id", ErrInvalid)
		}
		return "tenant/" + identity.SanitizeID(s.TenantID), nil
	case LevelSubscription:
		if s.TenantID == "" || s.SubsAccID == "" {
			return "", fmt.Errorf("%w: a subscription scope needs a tenant and a subscription id", ErrInvalid)
		}
		return "subs/" + identity.SanitizeID(s.TenantID) + "/" + identity.SanitizeID(s.SubsAccID), nil
	}
	return "", fmt.Errorf("%w: unknown scope level %q", ErrInvalid, s.Level)
}

// SetScopeDefault points one cascade level at a model.
//
// The model must be ACTIVE: a scope default is what new workspaces land on, and
// pointing it at a disabled model would produce workspaces picoclaw refuses to
// boot. A model that is already a scope default may still be DEPRECATED later —
// that is the normal retirement path, and Resolve hops to the replacement for
// new users without the admin re-pointing every scope first.
func (r *Registry) SetScopeDefault(sel ScopeSel, modelName string) error {
	key, err := sel.Key()
	if err != nil {
		return err
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		var m Model
		if err := getJSON(tx.Bucket(bModels), modelName, &m); err != nil {
			if err == ErrNotFound {
				return fmt.Errorf("%w: model %q does not exist", ErrInvalid, modelName)
			}
			return err
		}
		if m.Status != StatusActive {
			return fmt.Errorf("%w: model %q is %s and cannot be a scope default", ErrInvalid, modelName, m.Status)
		}
		return putJSON(tx.Bucket(bScopeDefaults), key, ScopeDefault{
			ModelName: modelName, UpdatedAt: r.now(),
		})
	})
}

func (r *Registry) GetScopeDefault(sel ScopeSel) (ScopeDefault, error) {
	key, err := sel.Key()
	if err != nil {
		return ScopeDefault{}, err
	}
	var d ScopeDefault
	err = r.db.View(func(tx *bolt.Tx) error {
		return getJSON(tx.Bucket(bScopeDefaults), key, &d)
	})
	if err != nil {
		return ScopeDefault{}, err
	}
	return d, nil
}

// ClearScopeDefault removes a level's default. Missing is a success: the admin's
// intent is already true.
func (r *Registry) ClearScopeDefault(sel ScopeSel) error {
	key, err := sel.Key()
	if err != nil {
		return err
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bScopeDefaults).Delete([]byte(key))
	})
}

// ListScopeDefaults returns every level's default keyed by scope key, for the
// admin UI and for the migration's drift reporting.
func (r *Registry) ListScopeDefaults() (map[string]ScopeDefault, error) {
	out := map[string]ScopeDefault{}
	err := r.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bScopeDefaults).ForEach(func(k, raw []byte) error {
			var d ScopeDefault
			if err := jsonUnmarshal(raw, &d); err != nil {
				return err
			}
			out[string(k)] = d
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// setScopeDefaultRaw writes without the active-model check, for the boot
// migration importing pre-existing overrides whose model may already be retired.
func (r *Registry) setScopeDefaultRaw(key, modelName string) error {
	return r.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket(bScopeDefaults), key, ScopeDefault{
			ModelName: modelName, UpdatedAt: r.now(),
		})
	})
}
```

- [ ] **Step 4: Remove the interim PutScopeDefault**

In `PROXY/internal/registry/referrers.go`, delete the `PutScopeDefault` method added in T03 Step 3 (its whole doc comment and body) — `SetScopeDefault` and `setScopeDefaultRaw` supersede it.

Then update the T03 test that used it. In `PROXY/internal/registry/referrers_test.go`, replace:

```go
	if err := r.PutScopeDefault("tenant/t", ScopeDefault{ModelName: "target"}); err != nil {
		t.Fatalf("PutScopeDefault: %v", err)
	}
```

with:

```go
	if err := r.SetScopeDefault(ScopeSel{Level: LevelTenant, TenantID: "t"}, "target"); err != nil {
		t.Fatalf("SetScopeDefault: %v", err)
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — all tests through T05, including the amended T03 test.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/
git commit -m "feat(registry): scope defaults and the cascade key vocabulary

A scope default must point at an ACTIVE model, since it is what new workspaces
land on. Deprecating a model that already IS a default stays allowed on purpose:
that is the retirement path, and the resolver hops to the replacement for new
users without the admin re-pointing every scope first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 06: `Resolve` — the single answer, with the deprecation hop and the declared chain

**Files:**
- Create: `PROXY/internal/registry/resolve.go`
- Create: `PROXY/internal/registry/resolve_test.go`

**Interfaces:**
- Consumes: T01–T05.
- Produces:
  - `registry.Resolution{Primary Model; Chain []Model; Level ScopeLevel; Skipped []string}`
  - `(*Registry).Resolve(ref WorkspaceRef) (Resolution, error)` — returns `ErrNoModelResolvable` when no level yields a model.
  - `(*Registry).WorkspacesUsing(modelName string) ([]WorkspaceRef, error)`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/registry/resolve_test.go`:

```go
package registry

import (
	"errors"
	"testing"
)

func ref() WorkspaceRef {
	return WorkspaceRef{TenantID: "t1", SubsAccID: "s1", Agent: "alpha", UserAccID: "u1"}
}

func TestResolveWalksEveryCascadeLevel(t *testing.T) {
	r := testRegistry(t)
	for _, n := range []string{"g", "ag", "te", "su", "us"} {
		mustCreate(t, r, n)
	}

	if _, err := r.Resolve(ref()); !errors.Is(err, ErrNoModelResolvable) {
		t.Fatalf("empty cascade: want ErrNoModelResolvable, got %v", err)
	}

	steps := []struct {
		set   func()
		want  string
		level ScopeLevel
	}{
		{func() { _ = r.SetScopeDefault(ScopeSel{Level: LevelGlobal}, "g") }, "g", LevelGlobal},
		{func() { _ = r.SetScopeDefault(ScopeSel{Level: LevelAgent, Agent: "alpha"}, "ag") }, "ag", LevelAgent},
		{func() { _ = r.SetScopeDefault(ScopeSel{Level: LevelTenant, TenantID: "t1"}, "te") }, "te", LevelTenant},
		{func() {
			_ = r.SetScopeDefault(ScopeSel{Level: LevelSubscription, TenantID: "t1", SubsAccID: "s1"}, "su")
		}, "su", LevelSubscription},
		{func() {
			_ = r.PutAssignment(ref(), Assignment{ModelName: "us", Source: SourceExplicit})
		}, "us", LevelUser},
	}
	for _, st := range steps {
		st.set()
		got, err := r.Resolve(ref())
		if err != nil {
			t.Fatalf("Resolve after setting %s: %v", st.level, err)
		}
		if got.Primary.ModelName != st.want || got.Level != st.level {
			t.Errorf("Resolve = %q at %q, want %q at %q",
				got.Primary.ModelName, got.Level, st.want, st.level)
		}
	}
}

func TestResolveIgnoresAnInheritedAssignmentAsAnOverride(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "scope")
	mustCreate(t, r, "stale")
	if err := r.SetScopeDefault(ScopeSel{Level: LevelSubscription, TenantID: "t1", SubsAccID: "s1"}, "scope"); err != nil {
		t.Fatal(err)
	}
	// An inherited assignment records what WAS materialized, not a pin. Treating
	// it as an override would freeze every workspace at its first model and make
	// scope defaults inert after the first provision.
	if err := r.PutAssignment(ref(), Assignment{ModelName: "stale", Source: SourceInherited}); err != nil {
		t.Fatal(err)
	}

	got, err := r.Resolve(ref())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Primary.ModelName != "scope" || got.Level != LevelSubscription {
		t.Errorf("Resolve = %q at %q, want scope at subscription", got.Primary.ModelName, got.Level)
	}
}

func TestResolveHopsDeprecationOnlyForAnUnmaterializedWorkspace(t *testing.T) {
	r := testRegistry(t)
	old := mustCreate(t, r, "old")
	mustCreate(t, r, "new")
	if err := r.SetScopeDefault(ScopeSel{Level: LevelTenant, TenantID: "t1"}, "old"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Deprecate("old", old.Version, "new"); err != nil {
		t.Fatalf("Deprecate: %v", err)
	}

	// A brand-new workspace lands on the replacement.
	fresh, err := r.Resolve(ref())
	if err != nil {
		t.Fatalf("Resolve fresh: %v", err)
	}
	if fresh.Primary.ModelName != "new" {
		t.Errorf("fresh workspace = %q, want new", fresh.Primary.ModelName)
	}

	// One already running the deprecated model keeps it.
	if err := r.PutAssignment(ref(), Assignment{ModelName: "old", Source: SourceInherited}); err != nil {
		t.Fatal(err)
	}
	kept, err := r.Resolve(ref())
	if err != nil {
		t.Fatalf("Resolve materialized: %v", err)
	}
	if kept.Primary.ModelName != "old" {
		t.Errorf("materialized workspace = %q, want old kept", kept.Primary.ModelName)
	}
}

func TestResolveChainIsThePrimarysDeclaredFallbacksOneLevelDeep(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "c")
	mustCreate(t, r, "b", "c") // b declares c, which must NOT be walked
	mustCreate(t, r, "a", "b")
	if err := r.SetScopeDefault(ScopeSel{Level: LevelGlobal}, "a"); err != nil {
		t.Fatal(err)
	}

	got, err := r.Resolve(ref())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(got.Chain) != 1 || got.Chain[0].ModelName != "b" {
		names := make([]string, len(got.Chain))
		for i, m := range got.Chain {
			names[i] = m.ModelName
		}
		t.Errorf("chain = %v, want exactly [b] (one level, no transitive walk)", names)
	}
}

func TestResolveSkipsANonActiveFallbackAndReportsIt(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "good")
	shelf := mustCreate(t, r, "shelf")
	mustCreate(t, r, "main", "shelf", "good")
	if err := r.SetScopeDefault(ScopeSel{Level: LevelGlobal}, "main"); err != nil {
		t.Fatal(err)
	}
	// Detach so disable is permitted, then re-attach via the raw mutator: this
	// reproduces the real state where a fallback was retired after being declared.
	if _, err := r.UpdateModelRaw("main", func(m *Model) error {
		m.Fallbacks = []string{"good"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.SetStatus("shelf", shelf.Version, StatusDisabled, ""); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if _, err := r.UpdateModelRaw("main", func(m *Model) error {
		m.Fallbacks = []string{"shelf", "good"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	got, err := r.Resolve(ref())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(got.Chain) != 1 || got.Chain[0].ModelName != "good" {
		t.Errorf("chain = %+v, want only good", got.Chain)
	}
	if len(got.Skipped) != 1 || got.Skipped[0] != "shelf" {
		t.Errorf("Skipped = %v, want [shelf] so the caller can log it", got.Skipped)
	}
}

func TestWorkspacesUsingFindsPrimaryAndChainHolders(t *testing.T) {
	r := testRegistry(t)
	mustCreate(t, r, "fb")
	mustCreate(t, r, "main", "fb")

	a := WorkspaceRef{TenantID: "t1", SubsAccID: "s1", Agent: "alpha", UserAccID: "u1"}
	b := WorkspaceRef{TenantID: "t1", SubsAccID: "s1", Agent: "alpha", UserAccID: "u2"}
	c := WorkspaceRef{TenantID: "t1", SubsAccID: "s1", Agent: "alpha", UserAccID: "u3"}
	if err := r.PutAssignment(a, Assignment{ModelName: "main", Chain: []string{"fb"}}); err != nil {
		t.Fatal(err)
	}
	if err := r.PutAssignment(b, Assignment{ModelName: "fb"}); err != nil {
		t.Fatal(err)
	}
	if err := r.PutAssignment(c, Assignment{ModelName: "other"}); err != nil {
		t.Fatal(err)
	}

	got, err := r.WorkspacesUsing("fb")
	if err != nil {
		t.Fatalf("WorkspacesUsing: %v", err)
	}
	// Both the chain holder and the primary holder must be returned: a key edit
	// that reached only primaries would leave the chain holder on a stale
	// credential.
	if len(got) != 2 {
		t.Fatalf("WorkspacesUsing = %+v, want 2 refs", got)
	}
	seen := map[string]bool{got[0].Key(): true, got[1].Key(): true}
	if !seen[a.Key()] || !seen[b.Key()] {
		t.Errorf("refs = %+v, want %s and %s", got, a.Key(), b.Key())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run 'TestResolve|TestWorkspacesUsing' -v`
Expected: FAIL — `r.Resolve undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/registry/resolve.go`:

```go
package registry

import (
	"fmt"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Resolution is what a workspace should have materialized.
type Resolution struct {
	// Primary is the model written to agents.defaults.provider/model_name.
	Primary Model
	// Chain is the primary's declared fallbacks, filtered to active models, in
	// declared order — written to agents.defaults.model_fallbacks.
	Chain []Model
	// Level reports which cascade rung decided the primary, for display.
	Level ScopeLevel
	// Skipped names declared fallbacks left out because they are not active, so
	// the caller can log the omission rather than silently shortening the chain.
	Skipped []string
}

// Names returns primary + chain model names in materialization order.
func (res Resolution) Names() []string {
	out := make([]string, 0, len(res.Chain)+1)
	out = append(out, res.Primary.ModelName)
	for _, m := range res.Chain {
		out = append(out, m.ModelName)
	}
	return out
}

// ChainNames returns just the fallback names, for the Assignment record.
func (res Resolution) ChainNames() []string {
	if len(res.Chain) == 0 {
		return nil
	}
	out := make([]string, 0, len(res.Chain))
	for _, m := range res.Chain {
		out = append(out, m.ModelName)
	}
	return out
}

// Resolve is THE answer to "which model does this workspace use". Every caller
// goes through it; there is deliberately no second path, because two paths
// writing agents.defaults is the bug this package exists to remove.
//
// Cascade, most specific first:
//
//	explicit per-user assignment > subscription > tenant > agent > global
//
// A deprecated result is followed to its replacement ONLY when the workspace has
// no materialized assignment. That single condition is what produces "new users
// get the successor while existing users keep the old model" without a separate
// code path.
func (r *Registry) Resolve(ref WorkspaceRef) (Resolution, error) {
	var res Resolution
	err := r.db.View(func(tx *bolt.Tx) error {
		models := tx.Bucket(bModels)

		var existing Assignment
		hasAssignment := getJSON(tx.Bucket(bAssignments), ref.Key(), &existing) == nil

		candidate, level, err := candidateTx(tx, ref, existing, hasAssignment)
		if err != nil {
			return err
		}

		var primary Model
		if err := getJSON(models, candidate, &primary); err != nil {
			return fmt.Errorf("cascade named model %q: %w", candidate, err)
		}

		// The hop: only an unmaterialized workspace follows the replacement.
		if primary.Status == StatusDeprecated && !hasAssignment {
			hopped, err := resolveReplacementTx(tx, candidate)
			if err != nil {
				return err
			}
			primary = hopped
		}

		chain := make([]Model, 0, len(primary.Fallbacks))
		var skipped []string
		for _, name := range primary.Fallbacks {
			var fb Model
			if err := getJSON(models, name, &fb); err != nil {
				skipped = append(skipped, name)
				continue
			}
			if fb.Status != StatusActive {
				skipped = append(skipped, name)
				continue
			}
			chain = append(chain, fb)
		}

		res = Resolution{Primary: primary, Chain: chain, Level: level, Skipped: skipped}
		return nil
	})
	if err != nil {
		return Resolution{}, err
	}
	return res, nil
}

// candidateTx returns the model_name the cascade selects and the level that
// selected it.
func candidateTx(tx *bolt.Tx, ref WorkspaceRef, existing Assignment, hasAssignment bool) (string, ScopeLevel, error) {
	// An EXPLICIT assignment is a pin and wins. An INHERITED one only records
	// what was materialized — treating it as an override would freeze every
	// workspace at its first model and make scope defaults inert after the first
	// provision.
	if hasAssignment && existing.Source == SourceExplicit && existing.ModelName != "" {
		return existing.ModelName, LevelUser, nil
	}

	sels := []ScopeSel{
		{Level: LevelSubscription, TenantID: ref.TenantID, SubsAccID: ref.SubsAccID},
		{Level: LevelTenant, TenantID: ref.TenantID},
		{Level: LevelAgent, Agent: ref.Agent},
		{Level: LevelGlobal},
	}
	defaults := tx.Bucket(bScopeDefaults)
	for _, sel := range sels {
		key, err := sel.Key()
		if err != nil {
			continue // an incomplete ref simply skips that level
		}
		var d ScopeDefault
		if err := getJSON(defaults, key, &d); err != nil {
			continue
		}
		if d.ModelName != "" {
			return d.ModelName, sel.Level, nil
		}
	}
	return "", "", fmt.Errorf("%w: workspace %s", ErrNoModelResolvable, ref.Key())
}

// resolveReplacementTx is ResolveReplacement inside an existing transaction.
func resolveReplacementTx(tx *bolt.Tx, name string) (Model, error) {
	b := tx.Bucket(bModels)
	seen := map[string]bool{}
	cursor := name
	for hop := 0; hop <= maxDeprecationHops; hop++ {
		if seen[cursor] {
			return Model{}, fmt.Errorf("%w: deprecation chain loops at %q", ErrInvalid, cursor)
		}
		seen[cursor] = true
		var m Model
		if err := getJSON(b, cursor, &m); err != nil {
			return Model{}, fmt.Errorf("deprecation chain from %q: %q: %w", name, cursor, err)
		}
		if m.Status != StatusDeprecated || m.ReplacedBy == "" {
			return m, nil
		}
		cursor = m.ReplacedBy
	}
	return Model{}, fmt.Errorf("%w: deprecation chain from %q exceeds %d hops", ErrInvalid, name, maxDeprecationHops)
}

// WorkspacesUsing lists every workspace whose materialized set contains the
// model — as primary OR as a chain member. The chain half is load-bearing: a key
// edit that reached only primaries would leave every fallback holder on a stale
// or revoked credential.
func (r *Registry) WorkspacesUsing(modelName string) ([]WorkspaceRef, error) {
	var out []WorkspaceRef
	err := r.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bAssignments).ForEach(func(k, raw []byte) error {
			var a Assignment
			if err := jsonUnmarshal(raw, &a); err != nil {
				return err
			}
			if a.ModelName != modelName && !contains(a.Chain, modelName) {
				return nil
			}
			ref, err := parseWorkspaceKey(string(k))
			if err != nil {
				return err
			}
			out = append(out, ref)
			return nil
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// parseWorkspaceKey inverts WorkspaceRef.Key. The ids are already sanitized, so
// the round trip yields the sanitized form — which is what every on-disk path is
// built from anyway.
func parseWorkspaceKey(key string) (WorkspaceRef, error) {
	parts := strings.Split(key, "/")
	if len(parts) != 4 {
		return WorkspaceRef{}, fmt.Errorf("malformed assignment key %q", key)
	}
	return WorkspaceRef{TenantID: parts[0], SubsAccID: parts[1], Agent: parts[2], UserAccID: parts[3]}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/registry/ -v`
Expected: PASS — every registry test.

- [ ] **Step 5: Verify the package vets clean and Phase A is self-contained**

Run: `cd PROXY && go vet ./internal/registry/ && go build ./...`
Expected: no output from either.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/
git commit -m "feat(registry): Resolve — the single answer, with the deprecation hop

One function answers 'which model does this workspace use'. Two paths writing
agents.defaults is the bug this package exists to remove, so there is
deliberately no second one.

The hop is conditioned on the ABSENCE of a materialized assignment, which is what
makes 'new users get the successor while existing users keep the old model' fall
out of resolution instead of needing its own code path. An INHERITED assignment
is not treated as an override: doing so would freeze every workspace at its
first model and make scope defaults inert after the first provision.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase A complete.** `internal/registry` is self-contained and fully tested; nothing wires it yet, so the proxy still behaves exactly as before.

---

## Phase B — Materialization

### Task 07: `materializeModels` — config.json without keys, .security.yml with keys and pruning

**Files:**
- Create: `PROXY/internal/docker/materialize.go`
- Create: `PROXY/internal/docker/materialize_test.go`

**Interfaces:**
- Consumes: `registry.Resolution`, `registry.Model`; existing `readSecurityConfig`, `writeSecurityConfig` (`internal/docker/secrets.go:281,300`), `chownTree` (`internal/docker/provision.go:212`).
- Produces:
  - `docker.materializeModels(configPath, secPath string, res registry.Resolution) error`
  - `docker.modelListEntry(m registry.Model) map[string]any`
  - `docker.pruneSecurityModelList(sec map[string]any, keep []string)`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/docker/materialize_test.go`:

```go
package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// seedWorkspaceFiles writes a minimal provisioned workspace: a config.json with
// an empty model_list (the new template shape) and a .security.yml holding the
// pico channel token plus a stale model key from a previous model.
func seedWorkspaceFiles(t *testing.T) (dir, configPath, secPath string) {
	t.Helper()
	dir = t.TempDir()
	configPath = filepath.Join(dir, "config.json")
	secPath = filepath.Join(dir, ".security.yml")

	cfg := map[string]any{
		"version":      3,
		"channel_list": map[string]any{"pico": map[string]any{"enabled": false}},
		"agents":       map[string]any{"defaults": map[string]any{"provider": "", "model_name": ""}},
		"model_list":   []any{},
	}
	raw, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	sec := "channel_list:\n  pico:\n    settings:\n      token: pico-seed\n" +
		"model_list:\n  retired-model:\n    api_keys:\n    - sk-old\n" +
		"web:\n  brave:\n    api_keys:\n    - brave-key\n"
	if err := os.WriteFile(secPath, []byte(sec), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, configPath, secPath
}

func testResolution() registry.Resolution {
	return registry.Resolution{
		Primary: registry.Model{
			ModelName: "main", Provider: "openai", Model: "gpt-5.4",
			APIBase: "https://api.openai.com/v1", APIKey: "sk-main", Status: registry.StatusActive,
			Fallbacks: []string{"backup"},
		},
		Chain: []registry.Model{{
			ModelName: "backup", Provider: "anthropic", Model: "claude-sonnet-4-6",
			APIBase: "https://api.anthropic.com/v1", APIKey: "sk-backup", Status: registry.StatusActive,
		}},
	}
}

func readConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestMaterializeWritesModelListWithoutAnyAPIKey(t *testing.T) {
	_, configPath, secPath := seedWorkspaceFiles(t)

	if err := materializeModels(configPath, secPath, testResolution()); err != nil {
		t.Fatalf("materializeModels: %v", err)
	}

	cfg := readConfig(t, configPath)
	list, ok := cfg["model_list"].([]any)
	if !ok || len(list) != 2 {
		t.Fatalf("model_list = %#v, want 2 entries", cfg["model_list"])
	}
	for i, item := range list {
		entry := item.(map[string]any)
		// picoclaw removed api_key (singular) from config.json in schema V2+ and
		// ignores it; the template is version 3. A key here is dead weight that
		// also leaks the secret into a file with looser handling than .security.yml.
		if _, present := entry["api_key"]; present {
			t.Errorf("model_list[%d] carries api_key: %#v", i, entry)
		}
		if entry["enabled"] != true {
			t.Errorf("model_list[%d].enabled = %#v, want true", i, entry["enabled"])
		}
	}
	first := list[0].(map[string]any)
	if first["model_name"] != "main" || first["provider"] != "openai" || first["api_base"] != "https://api.openai.com/v1" {
		t.Errorf("primary entry = %#v", first)
	}
}

func TestMaterializeSetsDefaultsAndFallbackOrder(t *testing.T) {
	_, configPath, secPath := seedWorkspaceFiles(t)

	if err := materializeModels(configPath, secPath, testResolution()); err != nil {
		t.Fatalf("materializeModels: %v", err)
	}

	cfg := readConfig(t, configPath)
	defaults := cfg["agents"].(map[string]any)["defaults"].(map[string]any)
	if defaults["provider"] != "openai" || defaults["model_name"] != "main" {
		t.Errorf("defaults = %#v", defaults)
	}
	fb, ok := defaults["model_fallbacks"].([]any)
	if !ok || len(fb) != 1 || fb[0] != "backup" {
		t.Errorf("model_fallbacks = %#v, want [backup]", defaults["model_fallbacks"])
	}
	// The pico channel must be enabled or the proxy cannot reach picoclaw at all.
	pico := cfg["channel_list"].(map[string]any)["pico"].(map[string]any)
	if pico["enabled"] != true {
		t.Errorf("channel_list.pico.enabled = %#v, want true", pico["enabled"])
	}
}

func TestMaterializeWritesKeysToSecurityAndPrunesStaleOnes(t *testing.T) {
	_, configPath, secPath := seedWorkspaceFiles(t)

	if err := materializeModels(configPath, secPath, testResolution()); err != nil {
		t.Fatalf("materializeModels: %v", err)
	}

	sec, err := readSecurityConfig(secPath)
	if err != nil {
		t.Fatalf("readSecurityConfig: %v", err)
	}
	ml, ok := sec["model_list"].(map[string]any)
	if !ok {
		t.Fatalf("model_list = %#v", sec["model_list"])
	}
	for name, wantKey := range map[string]string{"main": "sk-main", "backup": "sk-backup"} {
		entry, ok := ml[name].(map[string]any)
		if !ok {
			t.Fatalf("model_list.%s = %#v", name, ml[name])
		}
		keys, ok := entry["api_keys"].([]any)
		if !ok || len(keys) != 1 || keys[0] != wantKey {
			t.Errorf("model_list.%s.api_keys = %#v, want [%s]", name, entry["api_keys"], wantKey)
		}
	}
	// config.json's model_list is replaced wholesale while this file is
	// read-modify-write, so without pruning every model a workspace ever used
	// keeps its key here forever and the two files drift permanently.
	if _, present := ml["retired-model"]; present {
		t.Errorf("stale model key was not pruned: %#v", ml)
	}
	// Pruning must not reach past model_list.
	tok := sec["channel_list"].(map[string]any)["pico"].(map[string]any)["settings"].(map[string]any)["token"]
	if tok != "pico-seed" {
		t.Errorf("pico token = %#v, want pico-seed preserved", tok)
	}
	if _, present := sec["web"]; !present {
		t.Error("web.* family was removed; pruning must be scoped to model_list")
	}
}

func TestMaterializeIsIdempotent(t *testing.T) {
	_, configPath, secPath := seedWorkspaceFiles(t)
	res := testResolution()

	if err := materializeModels(configPath, secPath, res); err != nil {
		t.Fatalf("first: %v", err)
	}
	firstCfg, _ := os.ReadFile(configPath)
	firstSec, _ := os.ReadFile(secPath)

	if err := materializeModels(configPath, secPath, res); err != nil {
		t.Fatalf("second: %v", err)
	}
	secondCfg, _ := os.ReadFile(configPath)
	secondSec, _ := os.ReadFile(secPath)

	if string(firstCfg) != string(secondCfg) {
		t.Error("config.json changed on a repeat materialization")
	}
	if string(firstSec) != string(secondSec) {
		t.Error(".security.yml changed on a repeat materialization")
	}
}

func TestMaterializeCarriesOptionalFieldsOnlyWhenSet(t *testing.T) {
	_, configPath, secPath := seedWorkspaceFiles(t)
	res := registry.Resolution{Primary: registry.Model{
		ModelName: "oauth-model", Provider: "antigravity", Model: "gemini-3-flash",
		AuthMethod: "oauth", APIKey: "", Status: registry.StatusActive,
		ExtraBody: json.RawMessage(`{"reasoning_split":true}`),
	}}

	if err := materializeModels(configPath, secPath, res); err != nil {
		t.Fatalf("materializeModels: %v", err)
	}

	entry := readConfig(t, configPath)["model_list"].([]any)[0].(map[string]any)
	if entry["auth_method"] != "oauth" {
		t.Errorf("auth_method = %#v, want oauth", entry["auth_method"])
	}
	if _, present := entry["api_base"]; present {
		t.Errorf("api_base must be omitted when empty: %#v", entry)
	}
	eb, ok := entry["extra_body"].(map[string]any)
	if !ok || eb["reasoning_split"] != true {
		t.Errorf("extra_body = %#v", entry["extra_body"])
	}
	// A model with no key must not write an empty api_keys array, which picoclaw
	// would read as a configured-but-blank credential.
	sec, _ := readSecurityConfig(secPath)
	if ml, ok := sec["model_list"].(map[string]any); ok {
		if _, present := ml["oauth-model"]; present {
			t.Errorf("keyless model got a .security.yml entry: %#v", ml)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestMaterialize -v`
Expected: FAIL — `undefined: materializeModels`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/docker/materialize.go`:

```go
package docker

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// materializeModels writes a resolved model set into one workspace. It replaces
// applyModel's model handling and is the ONLY writer of a workspace's model
// configuration.
//
// config.json gets full model_list entries WITHOUT api_key: picoclaw removed
// api_key (singular) from config.json in schema V2+ and ignores it, and the
// shipped template is "version": 3. Keys go to .security.yml, which is the only
// sink that works — the containers receive no key environment variable
// (manager.go: Env is PICOCLAW_GATEWAY_HOST and HOME only).
func materializeModels(configPath, secPath string, res registry.Resolution) error {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read config.json: %w", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("parse config.json: %w", err)
	}

	// The pico channel is how the proxy reaches picoclaw at all; a workspace with
	// it disabled is unreachable regardless of its model.
	if cl, ok := cfg["channel_list"].(map[string]any); ok {
		if pico, ok := cl["pico"].(map[string]any); ok {
			pico["enabled"] = true
		}
	}

	models := append([]registry.Model{res.Primary}, res.Chain...)
	list := make([]any, 0, len(models))
	for _, m := range models {
		list = append(list, modelListEntry(m))
	}
	cfg["model_list"] = list

	if agents, ok := cfg["agents"].(map[string]any); ok {
		if defaults, ok := agents["defaults"].(map[string]any); ok {
			defaults["provider"] = res.Primary.Provider
			defaults["model_name"] = res.Primary.ModelName
			if names := res.ChainNames(); len(names) > 0 {
				fb := make([]any, 0, len(names))
				for _, n := range names {
					fb = append(fb, n)
				}
				defaults["model_fallbacks"] = fb
			} else {
				// Clear a stale chain rather than leaving one behind: the primary
				// may have had fallbacks and no longer does.
				delete(defaults, "model_fallbacks")
			}
		}
	}

	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(configPath, out, 0o600); err != nil {
		return fmt.Errorf("write config.json: %w", err)
	}

	sec, err := readSecurityConfig(secPath)
	if err != nil {
		return fmt.Errorf("read .security.yml: %w", err)
	}
	keep := make([]string, 0, len(models))
	for _, m := range models {
		if m.APIKey == "" {
			// No key to write. An empty api_keys array would read as a
			// configured-but-blank credential, which fails less clearly than an
			// absent entry (oauth models legitimately have no key).
			continue
		}
		setModelListEntry(sec, m.ModelName, m.APIKey)
		keep = append(keep, m.ModelName)
	}
	pruneSecurityModelList(sec, keep)
	if err := writeSecurityConfig(secPath, sec, ""); err != nil {
		return fmt.Errorf("write .security.yml: %w", err)
	}
	return nil
}

// modelListEntry renders one picoclaw model_list entry. Optional fields are
// omitted when unset so the file stays close to what an operator would hand-write.
func modelListEntry(m registry.Model) map[string]any {
	entry := map[string]any{
		"model_name": m.ModelName,
		"provider":   m.Provider,
		"model":      m.Model,
		"enabled":    true,
	}
	if m.APIBase != "" {
		entry["api_base"] = m.APIBase
	}
	if m.AuthMethod != "" {
		entry["auth_method"] = m.AuthMethod
	}
	if len(m.ExtraBody) > 0 {
		var eb any
		if err := json.Unmarshal(m.ExtraBody, &eb); err == nil {
			entry["extra_body"] = eb
		}
	}
	return entry
}

// pruneSecurityModelList drops model_list entries outside keep, and removes the
// section entirely when nothing is left. Scoped strictly to model_list: the pico
// channel token, the web.* families and native-secret overlay slots are the
// user's or the admin's data and are not this function's business.
func pruneSecurityModelList(sec map[string]any, keep []string) {
	ml, ok := sec["model_list"].(map[string]any)
	if !ok {
		return
	}
	wanted := make(map[string]bool, len(keep))
	for _, name := range keep {
		wanted[name] = true
	}
	for name := range ml {
		if !wanted[name] {
			delete(ml, name)
		}
	}
	if len(ml) == 0 {
		delete(sec, "model_list")
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/docker/ -run TestMaterialize -v`
Expected: PASS — all six tests.

- [ ] **Step 5: Run the whole package to confirm nothing regressed**

Run: `cd PROXY && go test ./internal/docker/`
Expected: PASS (the old `registered_models_test.go` and `provision_test.go` still pass — they are removed in T10).

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/materialize.go internal/docker/materialize_test.go
git commit -m "feat(docker): materializeModels — keys only in .security.yml, with pruning

config.json model_list entries carry no api_key: picoclaw ignores it in schema
V2+ and the template is version 3. .security.yml is the only sink that works —
the containers receive no key env var, so nothing would mask a broken write.

Pruning is not optional: config.json's model_list is replaced wholesale while
.security.yml is read-modify-write, so without it every model a workspace ever
used keeps its key there forever and the two files drift permanently.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 08: registry wiring into the Manager, provision refusal, empty template

**Files:**
- Modify: `PROXY/internal/docker/manager.go` (Manager struct, `NewManager`)
- Modify: `PROXY/internal/docker/provision.go:36-63` (provision signature and model application)
- Modify: `PROXY/internal/docker/defaulttemplate/picoclaw/config.json`
- Modify: `PROXY/cmd/crab-shell-proxy/main.go:44`
- Create: `PROXY/internal/docker/provision_model_test.go`

**Interfaces:**
- Consumes: T07 `materializeModels`; `registry.Registry`, `registry.Resolution`, `registry.WorkspaceRef`, `registry.ErrNoModelResolvable`, `registry.Assignment`, `registry.SourceExplicit`/`SourceInherited`.
- Produces:
  - `docker.Manager` gains an unexported `reg *registry.Registry` field
  - `docker.NewManager(cfg *config.Config, dkr Docker, health HealthChecker, reg *registry.Registry, logf func(string, ...any)) *Manager` — **signature change**, `reg` inserted before `logf`
  - `(*Manager).workspaceRef(key WorkspaceKey) registry.WorkspaceRef`
  - `(*Manager).resolveAndMaterialize(key WorkspaceKey, userDir string) error`
  - `docker.ErrNoModel = registry.ErrNoModelResolvable` re-export for the HTTP layer

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/docker/provision_model_test.go`:

```go
package docker

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

func testManagerWithRegistry(t *testing.T) (*Manager, *registry.Registry, string) {
	t.Helper()
	root := t.TempDir()
	at := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	reg, err := registry.Open(filepath.Join(root, "model-registry.db"), func() time.Time { return at })
	if err != nil {
		t.Fatalf("registry.Open: %v", err)
	}
	t.Cleanup(func() { _ = reg.Close() })
	m := &Manager{
		cfg:  &config.Config{ContainerDataRoot: root, PicoclawUser: ""},
		reg:  reg,
		logf: func(string, ...any) {},
	}
	return m, reg, root
}

func seedProvisionedWorkspace(t *testing.T, root string, key WorkspaceKey) string {
	t.Helper()
	userDir := config.UserWorkspace(root, key.TenantID, key.SubsAccID, key.Role, key.UserAccID)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := `{"version":3,"channel_list":{"pico":{"enabled":false}},` +
		`"agents":{"defaults":{"provider":"","model_name":""}},"model_list":[]}`
	if err := os.WriteFile(filepath.Join(userDir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	sec := "channel_list:\n  pico:\n    settings:\n      token: pico-seed\n"
	if err := os.WriteFile(filepath.Join(userDir, ".security.yml"), []byte(sec), 0o600); err != nil {
		t.Fatal(err)
	}
	return userDir
}

func TestResolveAndMaterializeRefusesWhenNoModelResolves(t *testing.T) {
	m, _, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedProvisionedWorkspace(t, root, key)

	err := m.resolveAndMaterialize(key, userDir)
	// picoclaw fails at startup when agents.defaults.model_name names a model
	// absent from model_list, so provisioning without one would produce a
	// permanently unbootable workspace. Refusing loudly is the only safe answer.
	if !errors.Is(err, registry.ErrNoModelResolvable) {
		t.Fatalf("want ErrNoModelResolvable, got %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(userDir, "config.json"))
	if string(raw) == "" {
		t.Fatal("config.json was emptied by a refused materialization")
	}
	if got := string(raw); got != `{"version":3,"channel_list":{"pico":{"enabled":false}},`+
		`"agents":{"defaults":{"provider":"","model_name":""}},"model_list":[]}` {
		t.Errorf("refused materialization still wrote config.json:\n%s", got)
	}
}

func TestResolveAndMaterializeRecordsAnInheritedAssignment(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedProvisionedWorkspace(t, root, key)

	if _, err := reg.CreateModel(registry.Model{
		ModelName: "m", Provider: "openai", Model: "gpt-5.4",
		APIBase: "https://api.openai.com/v1", APIKey: "sk-m", Status: registry.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := reg.SetScopeDefault(registry.ScopeSel{Level: registry.LevelTenant, TenantID: "t1"}, "m"); err != nil {
		t.Fatal(err)
	}

	if err := m.resolveAndMaterialize(key, userDir); err != nil {
		t.Fatalf("resolveAndMaterialize: %v", err)
	}

	a, err := reg.GetAssignment(m.workspaceRef(key))
	if err != nil {
		t.Fatalf("GetAssignment: %v", err)
	}
	if a.ModelName != "m" {
		t.Errorf("assignment model = %q, want m", a.ModelName)
	}
	// Source must be inherited: nothing pinned this user, the tenant default did.
	// Recording it as explicit would freeze the workspace against future scope
	// changes.
	if a.Source != registry.SourceInherited {
		t.Errorf("Source = %q, want inherited", a.Source)
	}
}

func TestResolveAndMaterializePreservesAnExplicitAssignmentSource(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedProvisionedWorkspace(t, root, key)

	for _, n := range []string{"pinned", "scoped"} {
		if _, err := reg.CreateModel(registry.Model{
			ModelName: n, Provider: "openai", Model: n,
			APIBase: "https://api.openai.com/v1", APIKey: "sk-" + n, Status: registry.StatusActive,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := reg.SetScopeDefault(registry.ScopeSel{Level: registry.LevelTenant, TenantID: "t1"}, "scoped"); err != nil {
		t.Fatal(err)
	}
	ref := m.workspaceRef(key)
	if err := reg.PutAssignment(ref, registry.Assignment{ModelName: "pinned", Source: registry.SourceExplicit}); err != nil {
		t.Fatal(err)
	}

	if err := m.resolveAndMaterialize(key, userDir); err != nil {
		t.Fatalf("resolveAndMaterialize: %v", err)
	}

	a, _ := reg.GetAssignment(ref)
	if a.ModelName != "pinned" || a.Source != registry.SourceExplicit {
		t.Errorf("assignment = %+v, want pinned/explicit — re-materializing must not demote a pin", a)
	}
}

func TestResolveAndMaterializeRecordsTheChain(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedProvisionedWorkspace(t, root, key)

	if _, err := reg.CreateModel(registry.Model{
		ModelName: "fb", Provider: "anthropic", Model: "claude-sonnet-4-6",
		APIBase: "https://api.anthropic.com/v1", APIKey: "sk-fb", Status: registry.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.CreateModel(registry.Model{
		ModelName: "main", Provider: "openai", Model: "gpt-5.4",
		APIBase: "https://api.openai.com/v1", APIKey: "sk-main", Status: registry.StatusActive,
		Fallbacks: []string{"fb"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := reg.SetScopeDefault(registry.ScopeSel{Level: registry.LevelGlobal}, "main"); err != nil {
		t.Fatal(err)
	}

	if err := m.resolveAndMaterialize(key, userDir); err != nil {
		t.Fatalf("resolveAndMaterialize: %v", err)
	}

	a, _ := reg.GetAssignment(m.workspaceRef(key))
	if len(a.Chain) != 1 || a.Chain[0] != "fb" {
		t.Errorf("Chain = %v, want [fb] so a key edit reaches this workspace", a.Chain)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestResolveAndMaterialize -v`
Expected: FAIL — `unknown field reg in struct literal`, `m.resolveAndMaterialize undefined`.

- [ ] **Step 3: Add the registry field and the two methods**

In `PROXY/internal/docker/manager.go`, add to the `Manager` struct (after the `health` field, line ~80):

```go
	// reg is the model inventory: the single source of truth for which model a
	// workspace uses. Nothing else in this package may decide that.
	reg *registry.Registry
```

Change `NewManager` (line ~93) to:

```go
// NewManager builds a Manager. If health is nil, an HTTP /health poller is used.
// reg is required: without the inventory there is no way to resolve a model, and
// a workspace provisioned without one cannot boot.
func NewManager(cfg *config.Config, dkr Docker, health HealthChecker, reg *registry.Registry, logf func(string, ...any)) *Manager {
	if health == nil {
		health = httpHealth
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Manager{cfg: cfg, docker: dkr, health: health, reg: reg, logf: logf, keys: map[string]*keyState{}}
}
```

Add the `registry` import to `manager.go`'s import block:

```go
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
```

Create the two methods at the end of `PROXY/internal/docker/materialize.go`:

```go
// ErrNoModel is the package-level alias the HTTP layer matches on, so handlers
// do not need to import registry just to classify one error.
var ErrNoModel = registry.ErrNoModelResolvable

// workspaceRef converts a WorkspaceKey into the registry's own ref. The registry
// cannot import this package (it would be a cycle), so the conversion lives here.
func (m *Manager) workspaceRef(key WorkspaceKey) registry.WorkspaceRef {
	return registry.WorkspaceRef{
		TenantID:  key.TenantID,
		SubsAccID: key.SubsAccID,
		Agent:     key.Role,
		UserAccID: key.UserAccID,
	}
}

// resolveAndMaterialize resolves the workspace's model and writes it. It is the
// single entry point every provision and every re-apply goes through.
//
// A workspace with no resolvable model is REFUSED, not defaulted: picoclaw fails
// at startup when agents.defaults.model_name names a model absent from
// model_list, so a silent default would produce a permanently unbootable
// container. Nothing is written on refusal.
func (m *Manager) resolveAndMaterialize(key WorkspaceKey, userDir string) error {
	ref := m.workspaceRef(key)
	res, err := m.reg.Resolve(ref)
	if err != nil {
		return err
	}
	for _, name := range res.Skipped {
		m.logf("materialize %s: fallback %q is not active, skipped", ref.Key(), name)
	}

	configPath := filepath.Join(userDir, "config.json")
	secPath := filepath.Join(userDir, ".security.yml")
	if err := materializeModels(configPath, secPath, res); err != nil {
		return err
	}

	// An existing EXPLICIT pin keeps its source: re-materializing must not demote
	// a deliberate per-user choice into an inherited one, which would let the next
	// scope-default change silently override it.
	source := registry.SourceInherited
	if prev, err := m.reg.GetAssignment(ref); err == nil && prev.Source == registry.SourceExplicit {
		source = registry.SourceExplicit
	}
	if err := m.reg.PutAssignment(ref, registry.Assignment{
		ModelName: res.Primary.ModelName,
		Chain:     res.ChainNames(),
		Source:    source,
	}); err != nil {
		return fmt.Errorf("record assignment: %w", err)
	}
	return chownTree(userDir, m.cfg.PicoclawUser)
}
```

Add `"path/filepath"` to `materialize.go`'s import block.

- [ ] **Step 4: Run the new tests**

Run: `cd PROXY && go test ./internal/docker/ -run TestResolveAndMaterialize -v`
Expected: PASS — all four tests.

- [ ] **Step 5: Wire the registry in main and fix the NewManager call**

In `PROXY/cmd/crab-shell-proxy/main.go`, before line 44, open the registry and pass it:

```go
	regPath := filepath.Join(cfg.ContainerDataRoot, "model-registry.db")
	reg, err := registry.Open(regPath, nil)
	if err != nil {
		logger.Fatalf("open model registry: %v", err)
	}
	defer func() { _ = reg.Close() }()

	mgr := docker.NewManager(cfg, dkr, nil, reg, logger.Printf)
```

Add the imports `"path/filepath"` and `"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"` to `main.go`.

- [ ] **Step 6: Empty the embedded template's model list**

In `PROXY/internal/docker/defaulttemplate/picoclaw/config.json`, replace the entire `"model_list": [ … 30 entries … ]` array (lines 263-448) with:

```json
  "model_list": [],
```

and in the same file set `agents.defaults.provider` and `agents.defaults.model_name` to `""` (they already are — verify, do not change if so).

The 30 entries are not lost: T09 moves them to an embedded read-only suggestion catalog.

- [ ] **Step 7: Verify the whole module still builds and the suite passes**

Run: `cd PROXY && go build ./... && go vet ./... && go test ./...`
Expected: PASS. If `provision_test.go` fails because `applyModel` still expects the template to declare a model, that is the T10 cutover — note the failing test name and continue; do not weaken the assertion here.

- [ ] **Step 8: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/manager.go internal/docker/materialize.go internal/docker/provision_model_test.go \
        internal/docker/defaulttemplate/picoclaw/config.json cmd/crab-shell-proxy/main.go
git commit -m "feat(docker): wire the registry into Manager; refuse to provision without a model

resolveAndMaterialize is the single entry point every provision and re-apply
goes through. A workspace with no resolvable model is refused rather than
defaulted: picoclaw fails at startup when agents.defaults.model_name names a
model absent from model_list, so a silent default produces a permanently
unbootable container.

Re-materializing preserves an EXPLICIT assignment's source, so a deliberate
per-user pin is not demoted to inherited and then silently overridden by the
next scope-default change.

The embedded template ships model_list: [] — the 30 entries become a read-only
suggestion catalog in the next commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 09: the embedded suggestion catalog

**Files:**
- Create: `PROXY/internal/docker/model-catalog.json`
- Create: `PROXY/internal/docker/model_catalog.go`
- Create: `PROXY/internal/docker/model_catalog_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `docker.CatalogEntry{Provider, Model, APIBase, AuthMethod string; ExtraBody json.RawMessage}`
  - `docker.SuggestionCatalog() ([]CatalogEntry, error)`

- [ ] **Step 1: Extract the catalog from the template's git history**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git show HEAD~1:internal/docker/defaulttemplate/picoclaw/config.json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([{k:v for k,v in e.items() if k!="model_name"} for e in d["model_list"]], indent=2))' \
  > internal/docker/model-catalog.json
head -12 internal/docker/model-catalog.json
```

Expected: a JSON array whose first element is `{"provider": "zhipu", "model": "glm-4.7", "api_base": "https://open.bigmodel.cn/api/paas/v4"}`. `model_name` is dropped on purpose — it is the admin's choice and must be unique in the inventory, so suggesting one would invite a duplicate.

- [ ] **Step 2: Write the failing test**

Create `PROXY/internal/docker/model_catalog_test.go`:

```go
package docker

import "testing"

func TestSuggestionCatalogParsesAndCarriesNoKeys(t *testing.T) {
	entries, err := SuggestionCatalog()
	if err != nil {
		t.Fatalf("SuggestionCatalog: %v", err)
	}
	if len(entries) < 20 {
		t.Fatalf("catalog has %d entries, want the full set (~30)", len(entries))
	}
	for i, e := range entries {
		if e.Provider == "" || e.Model == "" {
			t.Errorf("entry %d incomplete: %+v", i, e)
		}
		// Either an api_base or an auth_method must be present, or the entry
		// cannot prefill anything usable.
		if e.APIBase == "" && e.AuthMethod == "" {
			t.Errorf("entry %d has neither api_base nor auth_method: %+v", i, e)
		}
	}
}

func TestSuggestionCatalogIncludesKnownProviders(t *testing.T) {
	entries, err := SuggestionCatalog()
	if err != nil {
		t.Fatalf("SuggestionCatalog: %v", err)
	}
	want := map[string]bool{"openai": false, "anthropic": false, "zhipu": false, "ollama": false}
	for _, e := range entries {
		if _, tracked := want[e.Provider]; tracked {
			want[e.Provider] = true
		}
	}
	for p, found := range want {
		if !found {
			t.Errorf("catalog is missing provider %q", p)
		}
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestSuggestionCatalog -v`
Expected: FAIL — `undefined: SuggestionCatalog`.

- [ ] **Step 4: Write the implementation**

Create `PROXY/internal/docker/model_catalog.go`:

```go
package docker

import (
	"embed"
	"encoding/json"
	"fmt"
	"sync"
)

//go:embed model-catalog.json
var catalogFS embed.FS

// CatalogEntry is one suggested model definition. It never carries a key or a
// model_name: the key is the admin's secret and the name is the admin's choice,
// which must be unique in the inventory.
type CatalogEntry struct {
	Provider   string          `json:"provider"`
	Model      string          `json:"model"`
	APIBase    string          `json:"api_base,omitempty"`
	AuthMethod string          `json:"auth_method,omitempty"`
	ExtraBody  json.RawMessage `json:"extra_body,omitempty"`
}

var (
	catalogOnce sync.Once
	catalog     []CatalogEntry
	catalogErr  error
)

// SuggestionCatalog returns the embedded read-only catalog used to prefill the
// admin's register form, replacing the five free-text inputs that made typos the
// normal failure mode. It is never copied into a workspace — a workspace's
// model_list comes only from the inventory.
func SuggestionCatalog() ([]CatalogEntry, error) {
	catalogOnce.Do(func() {
		raw, err := catalogFS.ReadFile("model-catalog.json")
		if err != nil {
			catalogErr = fmt.Errorf("read embedded model catalog: %w", err)
			return
		}
		if err := json.Unmarshal(raw, &catalog); err != nil {
			catalogErr = fmt.Errorf("parse embedded model catalog: %w", err)
		}
	})
	return catalog, catalogErr
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/docker/ -run TestSuggestionCatalog -v`
Expected: PASS — both tests.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/model-catalog.json internal/docker/model_catalog.go internal/docker/model_catalog_test.go
git commit -m "feat(docker): embedded read-only model suggestion catalog

The 30 entries that used to ship in the template become prefill suggestions for
the admin register form. model_name is deliberately dropped: it is the admin's
choice and must be unique in the inventory, so suggesting one would invite a
duplicate. Never copied into a workspace.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: cut over — delete the two old systems, rebuild the re-apply paths

**Files:**
- Modify: `PROXY/internal/docker/provision.go` (`provision` signature, remove `applyModel`)
- Modify: `PROXY/internal/docker/manager.go` (the `provision`/`provisionHermes` call site, ~line 177-196)
- Rewrite: `PROXY/internal/docker/model.go` (keep only the re-apply entry points)
- Delete: `PROXY/internal/docker/registered_models.go`, `PROXY/internal/docker/registered_models_test.go`
- Modify: `PROXY/internal/docker/provision_test.go` (the `applyModel` test)
- Create: `PROXY/internal/docker/reapply_test.go`
- Modify: `PROXY/internal/httpapi/admin.go` (delete the model-override and registered-models handlers)
- Modify: `PROXY/internal/httpapi/handlers.go` (trim the `Docker` interface, drop the old routes)
- Modify: `PROXY/internal/httpapi/handlers_test.go` (the fake `Docker`)
- Delete: `PROXY/internal/httpapi/admin_model_test.go`

**Why this task carries the httpapi deletions:** the Global Constraint is that
`go vet ./... && go test ./...` passes, because that IS the Docker build gate. Deleting
the two docker-layer systems without removing their httpapi callers in the same task
would leave the module non-compiling across three tasks, so three task boundaries
would have no meaningful gate at all. Nothing is added here — the new handlers arrive
in T13/T14.

**Interfaces:**
- Consumes: T07–T09.
- Produces:
  - `(*Manager).ReapplyModelScope(scope Scope) error` — unchanged signature, registry-backed
  - `(*Manager).ReapplyModelUser(key WorkspaceKey) error` — **signature change**: the `agent config.Agent` parameter is gone (the registry needs no agent config)
  - `(*Manager).ReapplyModelForModel(modelName string) error` — new; re-materializes every workspace whose set contains the model
  - `(*Manager).reapplyWorkspace(key WorkspaceKey) error`
- Removed from `internal/docker`: `resolveModel`, `reapplyModel`, `getModelOverride`, `setModelOverride`, `clearModelOverride`, `EffectiveModel`, `SetModelOverride`, `ClearModelOverride`, `ModelSel`, `ModelTarget`, `modelOverridePath`, `applyModel`, and every `RegisteredModel*` symbol.
- Removed from `internal/httpapi`: `resolveModelTarget`, the old `handleAdminModelsList`, `handleAdminModelGet`, `handleAdminModelSet`, `handleAdminModelClear`, `handleAdminModelUsers`, `registeredModelRequest`, `applyRegisteredModelRequest`, all four `handleAdminRegisteredModel*` handlers, their route registrations, and the three model-override methods on the `Docker` interface.

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/docker/reapply_test.go`:

```go
package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

func TestReapplyModelForModelTouchesOnlyWorkspacesHoldingIt(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	// A no-op docker so the restart pass at the end of a re-apply is inert.
	m.docker = noopDocker{}

	for _, n := range []string{"fb", "other"} {
		if _, err := reg.CreateModel(registry.Model{
			ModelName: n, Provider: "openai", Model: n,
			APIBase: "https://api.openai.com/v1", APIKey: "sk-" + n, Status: registry.StatusActive,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reg.CreateModel(registry.Model{
		ModelName: "main", Provider: "openai", Model: "main",
		APIBase: "https://api.openai.com/v1", APIKey: "sk-main", Status: registry.StatusActive,
		Fallbacks: []string{"fb"},
	}); err != nil {
		t.Fatal(err)
	}

	holder := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "holder"}
	bystander := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "bystander"}
	holderDir := seedProvisionedWorkspace(t, root, holder)
	bystanderDir := seedProvisionedWorkspace(t, root, bystander)

	if err := reg.PutAssignment(m.workspaceRef(holder), registry.Assignment{
		ModelName: "main", Chain: []string{"fb"}, Source: registry.SourceExplicit,
	}); err != nil {
		t.Fatal(err)
	}
	if err := reg.PutAssignment(m.workspaceRef(bystander), registry.Assignment{
		ModelName: "other", Source: registry.SourceExplicit,
	}); err != nil {
		t.Fatal(err)
	}
	beforeBystander, _ := os.ReadFile(filepath.Join(bystanderDir, "config.json"))

	// Editing fb's key must reach the holder even though fb is only its FALLBACK.
	if err := m.ReapplyModelForModel("fb"); err != nil {
		t.Fatalf("ReapplyModelForModel: %v", err)
	}

	sec, err := readSecurityConfig(filepath.Join(holderDir, ".security.yml"))
	if err != nil {
		t.Fatal(err)
	}
	ml := sec["model_list"].(map[string]any)
	if _, ok := ml["fb"]; !ok {
		t.Errorf("holder did not get fb's key: %#v", ml)
	}

	afterBystander, _ := os.ReadFile(filepath.Join(bystanderDir, "config.json"))
	if string(beforeBystander) != string(afterBystander) {
		t.Error("a workspace that does not hold the model was re-materialized")
	}
}

func TestReapplyModelScopeLeavesAPinnedWorkspaceCompletelyAlone(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	var restarted []string
	m.docker = noopDocker{}
	m.logf = func(string, ...any) {}

	for _, n := range []string{"pinned", "scoped"} {
		if _, err := reg.CreateModel(registry.Model{
			ModelName: n, Provider: "openai", Model: n,
			APIBase: "https://api.openai.com/v1", APIKey: "sk-" + n, Status: registry.StatusActive,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := reg.SetScopeDefault(registry.ScopeSel{
		Level: registry.LevelSubscription, TenantID: "t1", SubsAccID: "s1",
	}, "scoped"); err != nil {
		t.Fatal(err)
	}

	pinned := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "pinned"}
	drifter := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "drifter"}
	pinnedDir := seedProvisionedWorkspace(t, root, pinned)
	seedProvisionedWorkspace(t, root, drifter)
	if err := reg.PutAssignment(m.workspaceRef(pinned), registry.Assignment{
		ModelName: "pinned", Source: registry.SourceExplicit,
	}); err != nil {
		t.Fatal(err)
	}
	if err := reg.PutAssignment(m.workspaceRef(drifter), registry.Assignment{
		ModelName: "scoped", Source: registry.SourceInherited,
	}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(pinnedDir, "config.json"))
	rec := &recordingDocker{}
	m.docker = rec

	if err := m.ReapplyModelScope(Scope{Kind: ScopeSubscription, TenantID: "t1", SubsAccID: "s1"}); err != nil {
		t.Fatalf("ReapplyModelScope: %v", err)
	}

	after, _ := os.ReadFile(filepath.Join(pinnedDir, "config.json"))
	if string(before) != string(after) {
		t.Error("a pinned workspace was re-materialized by a scope-default change")
	}
	// A no-op rewrite is invisible, but a restart is not: bouncing someone's agent
	// because a sibling's default changed is what "untouched" forbids.
	pinnedName := m.containerName(pinned)
	for _, n := range rec.stopped {
		if n == pinnedName {
			t.Errorf("pinned workspace %q was restarted; stopped = %v", pinnedName, rec.stopped)
		}
	}
	restarted = rec.stopped
	if len(restarted) == 0 {
		t.Log("no container was running, so no restart was expected — the file assertion above is the real check")
	}
}

func TestReapplyModelUserRewritesFromTheRegistry(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	m.docker = noopDocker{}

	if _, err := reg.CreateModel(registry.Model{
		ModelName: "chosen", Provider: "anthropic", Model: "claude-sonnet-4-6",
		APIBase: "https://api.anthropic.com/v1", APIKey: "sk-chosen", Status: registry.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedProvisionedWorkspace(t, root, key)
	if err := reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: "chosen", Source: registry.SourceExplicit,
	}); err != nil {
		t.Fatal(err)
	}

	if err := m.ReapplyModelUser(key); err != nil {
		t.Fatalf("ReapplyModelUser: %v", err)
	}

	raw, _ := os.ReadFile(filepath.Join(userDir, "config.json"))
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	defaults := cfg["agents"].(map[string]any)["defaults"].(map[string]any)
	if defaults["model_name"] != "chosen" {
		t.Errorf("model_name = %#v, want chosen", defaults["model_name"])
	}
}

func TestReapplySkipsAnUnprovisionedWorkspace(t *testing.T) {
	m, reg, _ := testManagerWithRegistry(t)
	m.docker = noopDocker{}

	if _, err := reg.CreateModel(registry.Model{
		ModelName: "m", Provider: "openai", Model: "m",
		APIBase: "https://api.openai.com/v1", APIKey: "sk-m", Status: registry.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "ghost"}
	if err := reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: "m", Source: registry.SourceExplicit,
	}); err != nil {
		t.Fatal(err)
	}

	// No config.json on disk: the workspace was never provisioned, so there is
	// nothing to rewrite. Resolution already applies at its first provision.
	if err := m.reapplyWorkspace(key); err != nil {
		t.Fatalf("reapplyWorkspace on an unprovisioned workspace should be a no-op, got %v", err)
	}
}
```

- [ ] **Step 2: Add the no-op Docker test double**

Append to `PROXY/internal/docker/reapply_test.go`:

```go
// noopDocker satisfies the Docker interface so a re-apply's trailing restart pass
// is inert in a unit test. Only the methods the restart path touches need real
// behaviour; the rest return zero values.
type noopDocker struct{}

func (noopDocker) List(ctx context.Context, label string) ([]Summary, error) { return nil, nil }
func (noopDocker) Create(ctx context.Context, spec CreateSpec) (string, error) { return "", nil }
func (noopDocker) Start(ctx context.Context, name string) error                { return nil }
func (noopDocker) Stop(ctx context.Context, name string) error                 { return nil }
func (noopDocker) Remove(ctx context.Context, name string) error               { return nil }
func (noopDocker) Inspect(ctx context.Context, name string) (Summary, error)   { return Summary{}, nil }

// recordingDocker is noopDocker plus a record of which containers were stopped, so
// a test can assert that a workspace was NOT restarted. A silent no-op rewrite is
// invisible in the files; a spurious restart is only visible here.
type recordingDocker struct {
	noopDocker
	stopped []string
}

func (r *recordingDocker) Stop(ctx context.Context, name string) error {
	r.stopped = append(r.stopped, name)
	return nil
}
```

Add `"context"` to the file's imports.

Run `cd PROXY && grep -n "type Docker interface" -A 25 internal/docker/client.go` and adjust `noopDocker` so it matches the interface exactly — add any missing method returning zero values, and delete any method the interface does not declare. `recordingDocker` embeds it, so only `Stop` needs overriding.

Also find the container-name helper the Manager uses (`cd PROXY && grep -n "func (m \*Manager) containerName\|func containerName" internal/docker/*.go`) and, if its name differs from `containerName(key)`, use the real one in the pinned-workspace assertion. If the Manager derives the name inline rather than through a helper, extract one — a test that cannot name a container cannot assert that it was left alone.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestReapply -v`
Expected: FAIL — `m.ReapplyModelForModel undefined`, and `ReapplyModelUser` still wants an `agent` argument.

- [ ] **Step 4: Rewrite model.go**

Replace the entire contents of `PROXY/internal/docker/model.go` with:

```go
package docker

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/identity"
)

// This file holds the re-apply entry points only. Model RESOLUTION lives in
// internal/registry and nowhere else: the previous version of this file resolved
// models from config.yaml while registered_models.go resolved them from disk, and
// neither knew about the other — so a scope re-apply silently overwrote a per-user
// assignment with no error and no way to recover the lost choice.

// ReapplyModelScope re-materializes the established workspaces under scope that a
// scope-default change actually affects, and restarts only those.
//
// A workspace with an EXPLICIT per-user pin is skipped entirely: its resolution did
// not change, so re-materializing would be a no-op — but restarting it would not.
// Bouncing someone's agent because a sibling's default changed is exactly what
// "workspaces with an explicit assignment are untouched" forbids. A workspace whose
// pinned MODEL changed is handled by ReapplyModelForModel, not by this path.
//
// A workspace that was never provisioned is skipped too: resolution already applies
// at its first provision.
//
// Per-workspace failures are logged and skipped rather than returned, so one bad
// workspace does not block the pass for the others.
func (m *Manager) ReapplyModelScope(scope Scope) error {
	keys, err := m.scopeWorkspaceKeys(scope)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if a, err := m.reg.GetAssignment(m.workspaceRef(key)); err == nil && a.Source == registry.SourceExplicit {
			continue
		}
		if err := m.reapplyWorkspace(key); err != nil {
			m.logf("reapply model scope: workspace %+v: %v", key, err)
			continue
		}
		if err := m.RestartWorkspace(key); err != nil {
			m.logf("reapply model scope: restart %+v: %v", key, err)
		}
	}
	return nil
}

// ReapplyModelUser re-materializes one workspace and restarts it if running
// (RestartWorkspace is a no-op when it is not — the next cold start picks up what
// is already on disk).
func (m *Manager) ReapplyModelUser(key WorkspaceKey) error {
	if err := m.reapplyWorkspace(key); err != nil {
		return err
	}
	return m.RestartWorkspace(key)
}

// ReapplyModelForModel re-materializes every workspace whose materialized set
// contains modelName — as primary OR as a chain member — and restarts them.
//
// The chain half is load-bearing: an api_base or key edit that reached only
// primaries would leave every workspace holding the model as a fallback on a
// stale or revoked credential, which is exactly the failure fallback exists to
// prevent.
func (m *Manager) ReapplyModelForModel(modelName string) error {
	refs, err := m.reg.WorkspacesUsing(modelName)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		key := WorkspaceKey{
			TenantID: ref.TenantID, SubsAccID: ref.SubsAccID,
			Role: ref.Agent, UserAccID: ref.UserAccID,
		}
		if err := m.reapplyWorkspace(key); err != nil {
			m.logf("reapply model %q: workspace %+v: %v", modelName, key, err)
			continue
		}
		if err := m.RestartWorkspace(key); err != nil {
			m.logf("reapply model %q: restart %+v: %v", modelName, key, err)
		}
	}
	return nil
}

// reapplyWorkspace re-materializes one ALREADY-PROVISIONED workspace. A missing
// config.json means it has never been provisioned, which is a no-op rather than
// an error.
func (m *Manager) reapplyWorkspace(key WorkspaceKey) error {
	userDir := config.UserWorkspace(m.cfg.ContainerDataRoot, key.TenantID, key.SubsAccID, key.Role, key.UserAccID)
	if _, err := os.Stat(filepath.Join(userDir, "config.json")); err != nil {
		return nil
	}
	return m.resolveAndMaterialize(key, userDir)
}

// scopeWorkspaceKeys enumerates every discovered WorkspaceKey under scope:
// ListSubscriptionUsers for a single subscription, or the
// tenants/<t>/subscriptions/*/agents/*/users/* glob for a whole tenant.
func (m *Manager) scopeWorkspaceKeys(scope Scope) ([]WorkspaceKey, error) {
	if scope.Kind == ScopeSubscription {
		users, err := m.ListSubscriptionUsers(scope.TenantID, scope.SubsAccID)
		if err != nil {
			return nil, err
		}
		keys := make([]WorkspaceKey, 0, len(users))
		for _, u := range users {
			keys = append(keys, WorkspaceKey{TenantID: scope.TenantID, SubsAccID: scope.SubsAccID, Role: u.Role, UserAccID: u.AccID})
		}
		return keys, nil
	}
	pattern := filepath.Join(m.cfg.ContainerDataRoot, "tenants", identity.SanitizeID(scope.TenantID),
		"subscriptions", "*", "agents", "*", "users", "*")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, err
	}
	var keys []WorkspaceKey
	for _, uw := range matches {
		fi, statErr := os.Stat(uw)
		if statErr != nil || !fi.IsDir() {
			continue
		}
		rel, err := filepath.Rel(m.cfg.ContainerDataRoot, uw)
		if err != nil {
			continue
		}
		// rel = tenants/<t>/subscriptions/<s>/agents/<role>/users/<u>
		parts := strings.Split(rel, string(os.PathSeparator))
		if len(parts) != 8 {
			continue
		}
		keys = append(keys, WorkspaceKey{TenantID: parts[1], SubsAccID: parts[3], Role: parts[5], UserAccID: parts[7]})
	}
	return keys, nil
}

// setModelListEntry upserts model_list[name] = {api_keys: [apiKey]} into the
// parsed .security.yml, creating model_list only if absent and leaving every
// sibling key untouched. materializeModels is its only caller.
func setModelListEntry(sec map[string]any, name, apiKey string) {
	ml, ok := sec["model_list"].(map[string]any)
	if !ok {
		ml = map[string]any{}
		sec["model_list"] = ml
	}
	ml[name] = map[string]any{"api_keys": []string{apiKey}}
}
```

- [ ] **Step 5: Delete the registered-models store**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git rm internal/docker/registered_models.go internal/docker/registered_models_test.go
```

- [ ] **Step 6: Replace applyModel in provision.go**

In `PROXY/internal/docker/provision.go`, delete the whole `applyModel` function (lines ~99-152, from its doc comment through its closing brace).

Change `provision`'s signature (line ~36) from

```go
func provision(userDir, templateDir, secretsDir, home, user string, model *config.ModelConfig, key WorkspaceKey, ownerEmail string) (picoToken string, err error) {
```

to

```go
// provision seeds a workspace from templateDir. The MODEL is not a parameter:
// the caller materializes it from the inventory after seeding, because that is
// the only place a model may come from.
func provision(userDir, templateDir, secretsDir, home, user string, key WorkspaceKey, ownerEmail string) (picoToken string, err error) {
```

Inside it, replace the `applyModel` block (lines ~59-63)

```go
			if err := applyModel(configPath, secPath, model); err != nil {
				return "", fmt.Errorf("apply model config: %w", err)
			}
		}
```

with

```go
			// The pico channel token is generated here; the model is materialized
			// by the caller from the inventory. Splitting these is what lets the
			// model come from exactly one place.
			if err := seedPicoToken(secPath); err != nil {
				return "", fmt.Errorf("seed pico token: %w", err)
			}
		}
```

and add, next to `randomToken` in the same file:

```go
// seedPicoToken writes a fresh proxy<->picoclaw channel token into a new
// workspace's .security.yml, preserving anything the template already put there.
func seedPicoToken(secPath string) error {
	token, err := randomToken()
	if err != nil {
		return err
	}
	sec, err := readSecurityConfig(secPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		sec = map[string]any{}
	}
	cl := childMap(sec, "channel_list")
	pico := childMap(cl, "pico")
	settings := childMap(pico, "settings")
	settings["token"] = token
	return writeSecurityConfig(secPath, sec, "")
}
```

(`childMap` already exists in `internal/docker/secrets.go`.)

- [ ] **Step 7: Update the provision call site in manager.go**

At `PROXY/internal/docker/manager.go` around line 177-196, the picoclaw branch changes from

```go
		authToken, err = provision(userDir, templateDir, effDir, m.cfg.PicoclawHome, m.cfg.PicoclawUser, model, key, ownerEmail)
```

to

```go
		authToken, err = provision(userDir, templateDir, effDir, m.cfg.PicoclawHome, m.cfg.PicoclawUser, key, ownerEmail)
		if err == nil {
			// Materialize AFTER seeding, so the template's (now empty) model_list
			// is replaced by the inventory's answer. A workspace with no
			// resolvable model fails here, before any container exists.
			err = m.resolveAndMaterialize(key, userDir)
		}
```

Leave the hermes branch untouched: hermes keeps reading `config.yaml`'s `agent.Model` this cycle (out of scope), so the `model` variable that branch uses stays.

- [ ] **Step 8: Fix the old applyModel test**

In `PROXY/internal/docker/provision_test.go`, the test at line ~53 calls `applyModel`. Replace that test function entirely with one that exercises the surviving behaviour:

```go
func TestSeedPicoTokenPreservesTemplateContentAndGeneratesAToken(t *testing.T) {
	dir := t.TempDir()
	secPath := filepath.Join(dir, ".security.yml")
	if err := os.WriteFile(secPath, []byte("web:\n  brave:\n    api_keys:\n    - seeded\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := seedPicoToken(secPath); err != nil {
		t.Fatalf("seedPicoToken: %v", err)
	}

	sec, err := readSecurityConfig(secPath)
	if err != nil {
		t.Fatalf("readSecurityConfig: %v", err)
	}
	tok, _ := sec["channel_list"].(map[string]any)["pico"].(map[string]any)["settings"].(map[string]any)["token"].(string)
	if !strings.HasPrefix(tok, "pico-") {
		t.Errorf("token = %q, want a pico- prefixed random token", tok)
	}
	// Only the nested pico.settings.token form is honored by picoclaw (the flat
	// form silently leaves the channel disabled), and the template's own keys
	// must survive.
	if _, ok := sec["web"]; !ok {
		t.Error("template content was clobbered")
	}
}
```

Ensure `provision_test.go` imports `"strings"`; drop any import it no longer uses.

- [ ] **Step 9: Run the docker package tests**

Run: `cd PROXY && go test ./internal/docker/ -v 2>&1 | tail -40`
Expected: PASS. Compile errors will point at remaining `applyModel` / `RegisteredModel` / `ModelSel` references — remove each one; they are all superseded. `internal/httpapi` still fails to build at this point; steps 9b–9e fix it inside this same task.

- [ ] **Step 9b: Delete the superseded httpapi handlers**

In `PROXY/internal/httpapi/admin.go`, delete from the `// --- admin-model-override …`
marker at line ~562 through the end of that feature's handlers:
`resolveModelTarget`, `handleAdminModelsList`, `handleAdminModelGet`,
`handleAdminModelSet`, `handleAdminModelClear`, `handleAdminModelUsers`, the
`registeredModelRequest` and `applyRegisteredModelRequest` types, and all four
`handleAdminRegisteredModel*` handlers.

In `PROXY/internal/httpapi/handlers.go`, delete the nine route registrations at lines
211-219 (`/v1/admin/models`, `/v1/admin/model`, `/v1/admin/model/users`,
`/v1/admin/registered-models`, `/v1/admin/registered-models/apply`). T13 and T14
register the replacements; leaving them registered here would reference deleted
handlers.

- [ ] **Step 9c: Trim the Docker interface**

In `PROXY/internal/httpapi/handlers.go`, delete from the `Docker` interface:

```go
	EffectiveModel(agent config.Agent, target docker.ModelTarget) (*config.ModelConfig, string)
	SetModelOverride(target docker.ModelTarget, sel docker.ModelSel) error
	ClearModelOverride(target docker.ModelTarget) error
```

and replace

```go
	ReapplyModelUser(key docker.WorkspaceKey, agent config.Agent) error
```

with

```go
	ReapplyModelUser(key docker.WorkspaceKey) error
	// ReapplyModelForModel re-materializes every workspace whose materialized set
	// contains the model — primaries AND chain holders.
	ReapplyModelForModel(modelName string) error
```

If `config` becomes an unused import in `handlers.go`, remove it.

- [ ] **Step 9d: Update the fake Docker and delete the obsolete test file**

In `PROXY/internal/httpapi/handlers_test.go`, remove the three deleted methods from the
fake, change `ReapplyModelUser` to the one-argument form, and add:

```go
func (f *fakeDocker) ReapplyModelForModel(modelName string) error { return nil }
```

Then:

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git rm internal/httpapi/admin_model_test.go
```

That file only exercised the deleted model-override endpoints.

- [ ] **Step 9e: Verify the whole module compiles and the suite passes**

Run: `cd PROXY && go build ./... && go vet ./... && go test ./... 2>&1 | tail -30`
Expected: PASS across every package. This is the Global Constraint's gate, and it must
hold at this task boundary — that is why the deletions above belong here rather than in
T14.

- [ ] **Step 10: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add -A internal/docker/ internal/httpapi/ cmd/
git commit -m "refactor: delete the two competing model systems, docker and httpapi together

resolveModel/reapplyModel (config.yaml cascade) and registered_models.go (disk
catalog) both wrote agents.defaults without knowing about each other, so a scope
re-apply silently overwrote a per-user assignment — unrecoverably, since the
assignment was never persisted anywhere but the file it clobbered. Both are gone;
internal/registry is the only resolver.

ReapplyModelForModel re-materializes chain holders too. An edit that reached only
primaries would leave every fallback holder on a stale credential, which is the
failure fallback exists to prevent.

provision no longer takes a model: it seeds the workspace and the caller
materializes from the inventory, so a model comes from exactly one place.

The httpapi callers go in the same commit rather than three tasks later: the build
gate is go vet + go test over the whole module, so splitting them would leave three
task boundaries with nothing to gate against. Nothing is added here — the
replacement endpoints arrive next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase B complete.** Workspaces are written from the inventory, both old systems are gone, and the whole module compiles with its suite green at this boundary.

---

## Phase C — Migration

### Task 11: import every pre-existing source, capture what each workspace runs

**Files:**
- Create: `PROXY/internal/docker/migrate_models.go`
- Create: `PROXY/internal/docker/migrate_models_test.go`

**Interfaces:**
- Consumes: T01–T10; `config.TemplatesDir`, `config.TenantModelOverrideFile`, `config.SubscriptionModelOverrideFile`, `config.UserModelOverrideFile`, `config.UserWorkspace`, `(*Manager).existingWorkspaces` (`internal/docker/reconcile.go`).
- Produces:
  - `(*Manager).migrateModelRegistry() error` — idempotent; a no-op once `meta.schema_version >= modelRegistrySchemaVersion`
  - `modelRegistrySchemaVersion = 1`

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/docker/migrate_models_test.go`:

```go
package docker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// seedLegacyWorkspace writes a workspace as the OLD code left it: the model
// declared in its own config.json model_list and its key in .security.yml.
func seedLegacyWorkspace(t *testing.T, root string, key WorkspaceKey, modelName, provider, apiKey string, fallbacks []string) string {
	t.Helper()
	userDir := config.UserWorkspace(root, key.TenantID, key.SubsAccID, key.Role, key.UserAccID)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	list := []any{map[string]any{
		"model_name": modelName, "provider": provider, "model": modelName,
		"api_base": "https://legacy.example/v1", "enabled": true,
	}}
	defaults := map[string]any{"provider": provider, "model_name": modelName}
	if len(fallbacks) > 0 {
		fb := make([]any, 0, len(fallbacks))
		for _, n := range fallbacks {
			fb = append(fb, n)
			list = append(list, map[string]any{
				"model_name": n, "provider": provider, "model": n,
				"api_base": "https://legacy.example/v1", "enabled": true,
			})
		}
		defaults["model_fallbacks"] = fb
	}
	cfg := map[string]any{
		"version":      3,
		"channel_list": map[string]any{"pico": map[string]any{"enabled": true}},
		"agents":       map[string]any{"defaults": defaults},
		"model_list":   list,
	}
	raw, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(filepath.Join(userDir, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	sec := "channel_list:\n  pico:\n    settings:\n      token: pico-legacy\nmodel_list:\n" +
		"  " + modelName + ":\n    api_keys:\n    - " + apiKey + "\n"
	for _, n := range fallbacks {
		sec += "  " + n + ":\n    api_keys:\n    - sk-" + n + "\n"
	}
	if err := os.WriteFile(filepath.Join(userDir, ".security.yml"), []byte(sec), 0o600); err != nil {
		t.Fatal(err)
	}
	return userDir
}

func TestMigrateImportsRegisteredModelsFile(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)

	dir := filepath.Join(root, "registered-models")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	payload := `[{"provider":"zhipu","name":"glm-4.7","model":"glm-4.7",
	  "api_base":"https://open.bigmodel.cn/api/paas/v4","api_key":"sk-zhipu"}]`
	if err := os.WriteFile(filepath.Join(dir, "alpha.json"), []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("migrateModelRegistry: %v", err)
	}

	got, err := reg.GetModel("glm-4.7")
	if err != nil {
		t.Fatalf("GetModel: %v", err)
	}
	// The key must survive: a registered-models entry holds a credential an admin
	// actually typed, which no other source can reproduce.
	if got.APIKey != "sk-zhipu" || got.Provider != "zhipu" {
		t.Errorf("imported = %+v, want the zhipu definition with its key", got)
	}
}

func TestMigrateImportsScopeAndUserOverrides(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	seedLegacyWorkspace(t, root, key, "legacy", "openai", "sk-legacy", nil)

	// A tenant-scope override file as admin-model-override wrote it.
	tf := config.TenantModelOverrideFile(root, "t1")
	if err := os.MkdirAll(filepath.Dir(tf), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tf, []byte(`{"provider":"openai","name":"legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// A per-user override dotfile.
	uf := config.UserModelOverrideFile(root, "t1", "s1", "alpha", "u1")
	if err := os.WriteFile(uf, []byte(`{"provider":"openai","name":"legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("migrateModelRegistry: %v", err)
	}

	d, err := reg.GetScopeDefault(registry.ScopeSel{Level: registry.LevelTenant, TenantID: "t1"})
	if err != nil || d.ModelName != "legacy" {
		t.Errorf("tenant default = %+v (err %v), want legacy", d, err)
	}
	a, err := reg.GetAssignment(m.workspaceRef(key))
	if err != nil {
		t.Fatalf("GetAssignment: %v", err)
	}
	// An override file was a deliberate pin, so it must import as EXPLICIT — as
	// inherited it would be silently overridden by the next scope change.
	if a.Source != registry.SourceExplicit || a.ModelName != "legacy" {
		t.Errorf("assignment = %+v, want legacy/explicit", a)
	}
}

func TestMigrateCapturesEveryWorkspacesCurrentModelAndChain(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	seedLegacyWorkspace(t, root, key, "orphan-primary", "venice", "sk-venice", []string{"orphan-fb"})

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("migrateModelRegistry: %v", err)
	}

	// This is the anti-orphaning step: without it every existing user reads as
	// unassigned and the first scope-default change re-resolves them.
	a, err := reg.GetAssignment(m.workspaceRef(key))
	if err != nil {
		t.Fatalf("GetAssignment: %v", err)
	}
	if a.ModelName != "orphan-primary" || a.Source != registry.SourceInherited {
		t.Errorf("assignment = %+v, want orphan-primary/inherited", a)
	}
	if len(a.Chain) != 1 || a.Chain[0] != "orphan-fb" {
		t.Errorf("Chain = %v, want [orphan-fb]", a.Chain)
	}

	// A model no other source declared is recovered from the workspace itself,
	// key included, and flagged for review.
	prim, err := reg.GetModel("orphan-primary")
	if err != nil {
		t.Fatalf("GetModel primary: %v", err)
	}
	if prim.APIKey != "sk-venice" || !prim.ImportedOrphan {
		t.Errorf("recovered primary = %+v, want the key and ImportedOrphan", prim)
	}
	fb, err := reg.GetModel("orphan-fb")
	if err != nil {
		t.Fatalf("GetModel fallback: %v", err)
	}
	if fb.APIKey != "sk-orphan-fb" {
		t.Errorf("recovered fallback key = %q, want sk-orphan-fb", fb.APIKey)
	}
	// The primary's declared chain is reconstructed from model_fallbacks, so the
	// workspace keeps working after the next re-materialization.
	if len(prim.Fallbacks) != 1 || prim.Fallbacks[0] != "orphan-fb" {
		t.Errorf("recovered Fallbacks = %v, want [orphan-fb]", prim.Fallbacks)
	}
}

func TestMigrateChangesNoWorkspacesActiveModel(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedLegacyWorkspace(t, root, key, "keepme", "openai", "sk-keepme", nil)
	before, _ := os.ReadFile(filepath.Join(userDir, "config.json"))

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("migrateModelRegistry: %v", err)
	}

	after, _ := os.ReadFile(filepath.Join(userDir, "config.json"))
	if string(before) != string(after) {
		t.Error("migration rewrote a workspace's config.json; it must only READ workspaces")
	}
	// And the recorded assignment must agree with what is on disk, so the drift
	// check reports clean immediately after.
	a, _ := reg.GetAssignment(m.workspaceRef(key))
	if a.ModelName != "keepme" {
		t.Errorf("assignment = %q, want keepme", a.ModelName)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	seedLegacyWorkspace(t, root, key, "once", "openai", "sk-once", nil)

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("first: %v", err)
	}
	v, err := reg.SchemaVersion()
	if err != nil || v != modelRegistrySchemaVersion {
		t.Fatalf("SchemaVersion = %d (err %v), want %d", v, err, modelRegistrySchemaVersion)
	}
	first, _ := reg.GetModel("once")

	// Tamper, then re-run: a second pass must not re-import over the admin's edit.
	if _, err := reg.UpdateModel("once", first.Version, func(mm *registry.Model) error {
		mm.APIBase = "https://edited.example/v1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("second: %v", err)
	}
	after, _ := reg.GetModel("once")
	if after.APIBase != "https://edited.example/v1" {
		t.Errorf("second migration clobbered an admin edit: %+v", after)
	}
}

func TestMigrateSkipsAWorkspaceWithNoActiveModelNamed(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := config.UserWorkspace(root, key.TenantID, key.SubsAccID, key.Role, key.UserAccID)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := `{"version":3,"agents":{"defaults":{"provider":"","model_name":""}},"model_list":[]}`
	if err := os.WriteFile(filepath.Join(userDir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := m.migrateModelRegistry(); err != nil {
		t.Fatalf("migrateModelRegistry: %v", err)
	}
	// Nothing to capture and nothing to invent: a workspace that never had a model
	// gets no assignment, and will resolve normally on its next start.
	if _, err := reg.GetAssignment(m.workspaceRef(key)); !errors.Is(err, registry.ErrNotFound) {
		t.Errorf("want ErrNotFound for a model-less workspace, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestMigrate -v`
Expected: FAIL — `m.migrateModelRegistry undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/docker/migrate_models.go`:

```go
package docker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// modelRegistrySchemaVersion marks the inventory as migrated. The marker is
// written LAST, so a failure anywhere leaves the whole pass re-runnable.
const modelRegistrySchemaVersion = 1

// legacyRegisteredModel is the on-disk shape of the deleted registered-models
// store, kept only so the migration can read what it left behind.
type legacyRegisteredModel struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	Model    string `json:"model"`
	APIBase  string `json:"api_base"`
	APIKey   string `json:"api_key"`
}

// legacyModelSel is the on-disk shape of an admin-model-override selection file.
type legacyModelSel struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
}

// migrateModelRegistry seeds the inventory from every pre-existing source and
// records what each existing workspace is currently running.
//
// It only READS workspaces — no workspace's active model changes as a result of
// migrating. Later sources win on model_name collision, because a
// registered-models entry or a live workspace holds a key an admin actually
// entered, whereas the config.yaml seed may name an environment variable that is
// no longer set.
func (m *Manager) migrateModelRegistry() error {
	have, err := m.reg.SchemaVersion()
	if err != nil {
		return err
	}
	if have >= modelRegistrySchemaVersion {
		return nil
	}
	root := m.cfg.ContainerDataRoot

	// 1. config.yaml: declared models, and each agent's default.
	//
	// config.ModelConfig.BaseURL is a hermes-only field and is EMPTY for every
	// picoclaw model — config.yaml never carried an api_base for them, because the
	// template's model_list did. So these records import without one, and picoclaw
	// falls back to its provider default. CreateModelRaw is used precisely because
	// the public API would reject a record with no api_base and no auth_method: the
	// shape is not the proxy's choice, it is what the old config expressed. An admin
	// editing such a record in the UI supplies the api_base then.
	for _, agent := range m.cfg.Agents {
		for _, mc := range agent.SelectableModels() {
			m.importLegacyModel(registry.Model{
				ModelName: mc.Name, Provider: mc.Provider, Model: mc.Name,
				APIBase: mc.BaseURL, APIKey: mc.APIKey, Status: registry.StatusActive,
			})
		}
		if agent.Model != nil && agent.Model.Name != "" {
			key, kerr := registry.ScopeSel{Level: registry.LevelAgent, Agent: agent.Key}.Key()
			if kerr == nil {
				if err := m.reg.SetScopeDefaultRaw(key, agent.Model.Name); err != nil {
					m.logf("migrate models: agent %q default: %v", agent.Key, err)
				}
			}
		}
	}

	// 2. registered-models/<agent>.json — real keys an admin typed.
	entries, _ := filepath.Glob(filepath.Join(root, "registered-models", "*.json"))
	for _, path := range entries {
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			m.logf("migrate models: read %s: %v", path, rerr)
			continue
		}
		var legacy []legacyRegisteredModel
		if jerr := json.Unmarshal(raw, &legacy); jerr != nil {
			m.logf("migrate models: parse %s: %v", path, jerr)
			continue
		}
		for _, l := range legacy {
			m.importLegacyModel(registry.Model{
				ModelName: l.Name, Provider: l.Provider, Model: l.Model,
				APIBase: l.APIBase, APIKey: l.APIKey, Status: registry.StatusActive,
			})
		}
	}

	// 3. Scope override files -> scope defaults.
	m.importOverrideFiles(root)

	// 4. Every existing workspace: capture what it is actually running.
	for _, agent := range m.cfg.Agents {
		for _, key := range m.existingWorkspaces(agent.Key) {
			if err := m.captureWorkspaceModel(key); err != nil {
				m.logf("migrate models: capture %+v: %v", key, err)
			}
		}
	}

	m.logf("migrate models: superseded files are no longer read " +
		"(registered-models/*.json, tenants/*/shared/model.json, " +
		"tenants/*/subscriptions/*/shared/model.json, .crab-model.json); " +
		"they are left on disk for rollback")
	return m.reg.SetSchemaVersion(modelRegistrySchemaVersion)
}

// importLegacyModel creates a record unless one already exists with that name.
// Skipping an existing name is what makes the pass safe to re-run and keeps a
// later, better source (a real key) from being overwritten by an earlier one.
func (m *Manager) importLegacyModel(mod registry.Model) {
	if mod.ModelName == "" || mod.Provider == "" {
		return
	}
	if mod.Model == "" {
		mod.Model = mod.ModelName
	}
	if _, err := m.reg.GetModel(mod.ModelName); err == nil {
		// Already present. Fill in a key only if the record has none — a later
		// source holding a real credential should win over an empty one.
		if mod.APIKey != "" {
			if _, uerr := m.reg.UpdateModelRaw(mod.ModelName, func(cur *registry.Model) error {
				if cur.APIKey == "" {
					cur.APIKey = mod.APIKey
				}
				return nil
			}); uerr != nil {
				m.logf("migrate models: backfill key for %q: %v", mod.ModelName, uerr)
			}
		}
		return
	}
	if _, err := m.reg.CreateModelRaw(mod); err != nil {
		m.logf("migrate models: import %q: %v", mod.ModelName, err)
	}
}

// importOverrideFiles reads admin-model-override's selection files into scope
// defaults. A per-user file is handled by captureWorkspaceModel, which knows the
// workspace it belongs to.
func (m *Manager) importOverrideFiles(root string) {
	tenantFiles, _ := filepath.Glob(filepath.Join(root, "tenants", "*", "shared", "model.json"))
	for _, path := range tenantFiles {
		sel, ok := readLegacySel(path)
		if !ok {
			continue
		}
		// tenants/<t>/shared/model.json
		tenant := filepath.Base(filepath.Dir(filepath.Dir(path)))
		key, err := registry.ScopeSel{Level: registry.LevelTenant, TenantID: tenant}.Key()
		if err == nil {
			if serr := m.reg.SetScopeDefaultRaw(key, sel.Name); serr != nil {
				m.logf("migrate models: tenant default %s: %v", tenant, serr)
			}
		}
	}

	subsFiles, _ := filepath.Glob(filepath.Join(root, "tenants", "*", "subscriptions", "*", "shared", "model.json"))
	for _, path := range subsFiles {
		sel, ok := readLegacySel(path)
		if !ok {
			continue
		}
		// tenants/<t>/subscriptions/<s>/shared/model.json
		subs := filepath.Base(filepath.Dir(filepath.Dir(path)))
		tenant := filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(path)))))
		key, err := registry.ScopeSel{Level: registry.LevelSubscription, TenantID: tenant, SubsAccID: subs}.Key()
		if err == nil {
			if serr := m.reg.SetScopeDefaultRaw(key, sel.Name); serr != nil {
				m.logf("migrate models: subscription default %s/%s: %v", tenant, subs, serr)
			}
		}
	}
}

func readLegacySel(path string) (legacyModelSel, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return legacyModelSel{}, false
	}
	var sel legacyModelSel
	if err := json.Unmarshal(raw, &sel); err != nil || sel.Name == "" {
		return legacyModelSel{}, false
	}
	return sel, true
}

// captureWorkspaceModel records what one workspace is running, recovering any
// model no other source declared from the workspace's own files.
//
// This is the step that prevents orphaning: without it every existing user reads
// as unassigned, and the first scope-default change re-resolves them all.
func (m *Manager) captureWorkspaceModel(key WorkspaceKey) error {
	userDir := config.UserWorkspace(m.cfg.ContainerDataRoot, key.TenantID, key.SubsAccID, key.Role, key.UserAccID)
	configPath := filepath.Join(userDir, "config.json")
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil // never provisioned
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("parse config.json: %w", err)
	}
	agents, _ := cfg["agents"].(map[string]any)
	defaults, _ := agents["defaults"].(map[string]any)
	primary, _ := defaults["model_name"].(string)
	if primary == "" {
		return nil // no model was ever pinned here; it resolves normally next start
	}

	var chain []string
	if fb, ok := defaults["model_fallbacks"].([]any); ok {
		for _, v := range fb {
			if s, ok := v.(string); ok && s != "" {
				chain = append(chain, s)
			}
		}
	}

	// Recover any named model the inventory does not have, from this workspace's
	// own model_list definition and .security.yml key.
	secPath := filepath.Join(userDir, ".security.yml")
	for _, name := range append([]string{primary}, chain...) {
		if _, err := m.reg.GetModel(name); err == nil {
			continue
		}
		mod, ok := recoverModelFromWorkspace(cfg, secPath, name)
		if !ok {
			m.logf("migrate models: workspace %+v names model %q that no source declares "+
				"and its own config.json does not define — left unregistered for admin review", key, name)
			continue
		}
		mod.ImportedOrphan = true
		if _, err := m.reg.CreateModelRaw(mod); err != nil {
			m.logf("migrate models: recover %q from workspace %+v: %v", name, key, err)
		}
	}
	// Reconstruct the primary's declared chain from what the workspace was running,
	// so the next re-materialization reproduces the same set.
	if len(chain) > 0 {
		if _, err := m.reg.UpdateModelRaw(primary, func(cur *registry.Model) error {
			if len(cur.Fallbacks) == 0 {
				cur.Fallbacks = chain
			}
			return nil
		}); err != nil {
			m.logf("migrate models: reconstruct chain for %q: %v", primary, err)
		}
	}

	// An imported per-user override file was a deliberate pin; anything else is
	// inherited. Recording a pin as inherited would let the next scope change
	// silently override it.
	source := registry.SourceInherited
	if _, err := os.Stat(config.UserModelOverrideFile(m.cfg.ContainerDataRoot,
		key.TenantID, key.SubsAccID, key.Role, key.UserAccID)); err == nil {
		source = registry.SourceExplicit
	}
	return m.reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: primary, Chain: chain, Source: source,
	})
}

// recoverModelFromWorkspace rebuilds a model record from one workspace's own
// files — the only place a model that no other source declares still exists.
func recoverModelFromWorkspace(cfg map[string]any, secPath, name string) (registry.Model, bool) {
	list, _ := cfg["model_list"].([]any)
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if n, _ := entry["model_name"].(string); n != name {
			continue
		}
		mod := registry.Model{
			ModelName: name,
			Status:    registry.StatusActive,
		}
		mod.Provider, _ = entry["provider"].(string)
		mod.Model, _ = entry["model"].(string)
		mod.APIBase, _ = entry["api_base"].(string)
		mod.AuthMethod, _ = entry["auth_method"].(string)
		if mod.Model == "" {
			mod.Model = name
		}
		if mod.Provider == "" {
			return registry.Model{}, false
		}
		mod.APIKey = readWorkspaceModelKey(secPath, name)
		return mod, true
	}
	return registry.Model{}, false
}

// readWorkspaceModelKey pulls model_list.<name>.api_keys[0] out of a workspace's
// .security.yml — the sink the old code wrote and the only one picoclaw reads.
func readWorkspaceModelKey(secPath, name string) string {
	sec, err := readSecurityConfig(secPath)
	if err != nil {
		return ""
	}
	ml, ok := sec["model_list"].(map[string]any)
	if !ok {
		return ""
	}
	entry, ok := ml[name].(map[string]any)
	if !ok {
		return ""
	}
	keys, ok := entry["api_keys"].([]any)
	if !ok || len(keys) == 0 {
		return ""
	}
	s, _ := keys[0].(string)
	return s
}
```

- [ ] **Step 4: Export the two raw helpers the migration needs**

The migration writes records the public API would refuse (a retired model as a scope default, a record with a pre-set version). Export them from the registry.

In `PROXY/internal/registry/scopes.go`, rename `setScopeDefaultRaw` to `SetScopeDefaultRaw` and update its doc comment to:

```go
// SetScopeDefaultRaw writes a scope default WITHOUT the active-model check. It
// exists for the boot migration, which imports pre-existing overrides whose model
// may already be retired. Never call it from an HTTP handler.
func (r *Registry) SetScopeDefaultRaw(key, modelName string) error {
```

Append to `PROXY/internal/registry/models.go`:

```go
// CreateModelRaw inserts a record without the create-time restrictions the public
// API enforces (it accepts a deprecated status and a blank api_base). It exists
// for the boot migration recovering records from live workspaces, whose shape the
// proxy did not choose. Never call it from an HTTP handler.
func (r *Registry) CreateModelRaw(m Model) (Model, error) {
	if m.ModelName == "" {
		return Model{}, fmt.Errorf("%w: model_name is required", ErrInvalid)
	}
	if m.Status == "" {
		m.Status = StatusActive
	}
	var out Model
	err := r.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bModels)
		if b.Get([]byte(m.ModelName)) != nil {
			return fmt.Errorf("%w: %q", ErrDuplicate, m.ModelName)
		}
		if m.Position == 0 {
			m.Position = b.Stats().KeyN + 1
		}
		at := r.now()
		m.Version = 1
		m.CreatedAt = at
		m.UpdatedAt = at
		out = m
		return putJSON(b, m.ModelName, m)
	})
	if err != nil {
		return Model{}, err
	}
	return out, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd PROXY && go test ./internal/docker/ -run TestMigrate -v`
Expected: PASS — all seven tests.

- [ ] **Step 6: Verify `existingWorkspaces` has the expected signature**

Run: `cd PROXY && grep -n "func (m \*Manager) existingWorkspaces" internal/docker/reconcile.go`
Expected: `func (m *Manager) existingWorkspaces(agentKey string) []WorkspaceKey`. If it returns an error too, adapt the two call sites in `migrateModelRegistry`.

- [ ] **Step 7: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/migrate_models.go internal/docker/migrate_models_test.go internal/registry/
git commit -m "feat(docker): one-time inventory migration that captures current reality

Step 4 is the anti-orphaning step: it reads every existing workspace's own
config.json and .security.yml and records what that workspace is RUNNING. Without
it every existing user reads as unassigned and the first scope-default change
re-resolves them all — the exact failure this feature exists to remove.

The pass only READS workspaces, so migrating changes no workspace's active model.
Later sources win on name collision because a registered-models entry or a live
workspace holds a key an admin actually typed, while the config.yaml seed may name
an env var that is no longer set. The schema marker is written last, so any
failure leaves the pass re-runnable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: template normalization, boot wiring, drift check

**Files:**
- Create: `PROXY/internal/docker/drift.go`
- Create: `PROXY/internal/docker/drift_test.go`
- Modify: `PROXY/internal/docker/migrate_models.go` (add the normalization step)
- Modify: `PROXY/internal/docker/reconcile.go` (call the migration and the drift check)

**Interfaces:**
- Consumes: T11.
- Produces:
  - `(*Manager).normalizeDiskTemplates() error`
  - `(*Manager).checkModelDrift()` — logs only
  - `Reconcile` calls `migrateModelRegistry` then `checkModelDrift` before its existing work

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/docker/drift_test.go`:

```go
package docker

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

func TestNormalizeDiskTemplatesEmptiesModelListAndBacksUp(t *testing.T) {
	m, _, root := testManagerWithRegistry(t)
	tmplDir := config.TemplatesDir(root, "picoclaw")
	if err := os.MkdirAll(tmplDir, 0o700); err != nil {
		t.Fatal(err)
	}
	original := `{"version":3,"agents":{"defaults":{"provider":"zhipu","model_name":"glm-4.7"}},` +
		`"model_list":[{"model_name":"glm-4.7","provider":"zhipu","model":"glm-4.7"}]}`
	tmplPath := filepath.Join(tmplDir, "config.json")
	if err := os.WriteFile(tmplPath, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	m.cfg.Agents = map[string]config.Agent{"alpha": {Key: "alpha", Template: "picoclaw"}}

	if err := m.normalizeDiskTemplates(); err != nil {
		t.Fatalf("normalizeDiskTemplates: %v", err)
	}

	raw, _ := os.ReadFile(tmplPath)
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	list, ok := cfg["model_list"].([]any)
	if !ok || len(list) != 0 {
		t.Errorf("model_list = %#v, want []", cfg["model_list"])
	}
	defaults := cfg["agents"].(map[string]any)["defaults"].(map[string]any)
	if defaults["provider"] != "" || defaults["model_name"] != "" {
		t.Errorf("defaults = %#v, want both cleared", defaults)
	}

	// This is the migration's only destructive write, so it must be reversible by
	// hand.
	backup, err := os.ReadFile(tmplPath + ".pre-registry")
	if err != nil {
		t.Fatalf("backup missing: %v", err)
	}
	if string(backup) != original {
		t.Errorf("backup = %s, want the original verbatim", backup)
	}
}

func TestNormalizeDiskTemplatesDoesNotOverwriteAnExistingBackup(t *testing.T) {
	m, _, root := testManagerWithRegistry(t)
	tmplDir := config.TemplatesDir(root, "picoclaw")
	if err := os.MkdirAll(tmplDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tmplPath := filepath.Join(tmplDir, "config.json")
	if err := os.WriteFile(tmplPath, []byte(`{"model_list":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmplPath+".pre-registry", []byte(`{"original":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	m.cfg.Agents = map[string]config.Agent{"alpha": {Key: "alpha", Template: "picoclaw"}}

	if err := m.normalizeDiskTemplates(); err != nil {
		t.Fatalf("normalizeDiskTemplates: %v", err)
	}

	// A re-run must not replace the real original with an already-normalized copy.
	backup, _ := os.ReadFile(tmplPath + ".pre-registry")
	if string(backup) != `{"original":true}` {
		t.Errorf("backup was overwritten: %s", backup)
	}
}

func TestCheckModelDriftLogsAMismatchAndStaysSilentWhenClean(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	var logged []string
	m.logf = func(format string, args ...any) {
		logged = append(logged, format)
	}
	m.cfg.Agents = map[string]config.Agent{"alpha": {Key: "alpha", Template: "picoclaw"}}

	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	seedLegacyWorkspace(t, root, key, "ondisk", "openai", "sk-ondisk", nil)
	if err := reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: "recorded", Source: registry.SourceInherited,
	}); err != nil {
		t.Fatal(err)
	}

	m.checkModelDrift()

	var found bool
	for _, l := range logged {
		if strings.Contains(l, "drift") {
			found = true
		}
	}
	if !found {
		t.Errorf("a mismatch must be logged; logged = %v", logged)
	}

	// Correcting the record clears the report — the check is read-only, so it must
	// reflect state rather than remember a past complaint.
	logged = nil
	if err := reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: "ondisk", Source: registry.SourceInherited,
	}); err != nil {
		t.Fatal(err)
	}
	m.checkModelDrift()
	for _, l := range logged {
		if strings.Contains(l, "drift") {
			t.Errorf("clean state still reported drift: %v", logged)
		}
	}
}

func TestCheckModelDriftDoesNotModifyAnything(t *testing.T) {
	m, reg, root := testManagerWithRegistry(t)
	m.cfg.Agents = map[string]config.Agent{"alpha": {Key: "alpha", Template: "picoclaw"}}
	key := WorkspaceKey{TenantID: "t1", SubsAccID: "s1", Role: "alpha", UserAccID: "u1"}
	userDir := seedLegacyWorkspace(t, root, key, "ondisk", "openai", "sk-ondisk", nil)
	if err := reg.PutAssignment(m.workspaceRef(key), registry.Assignment{
		ModelName: "recorded", Source: registry.SourceInherited,
	}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(userDir, "config.json"))

	m.checkModelDrift()

	after, _ := os.ReadFile(filepath.Join(userDir, "config.json"))
	if string(before) != string(after) {
		t.Error("drift check rewrote a workspace; a correction is an explicit admin reapply")
	}
	a, _ := reg.GetAssignment(m.workspaceRef(key))
	if a.ModelName != "recorded" {
		t.Error("drift check rewrote the assignment")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run 'TestNormalize|TestCheckModelDrift' -v`
Expected: FAIL — `m.normalizeDiskTemplates undefined`.

- [ ] **Step 3: Write the implementation**

Create `PROXY/internal/docker/drift.go`:

```go
package docker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/config"
)

// normalizeDiskTemplates empties every per-instance disk template's model_list
// and clears its pinned default.
//
// Leaving models in a template would keep a place the truth could appear to live:
// an operator editing it would get no effect and no explanation, because
// materialization overwrites model_list wholesale from the inventory. Nothing in
// use is lost — the migration already recovered every running model from the
// workspaces themselves, which is where a working model provably exists.
// It enumerates templates from DISK, not from m.cfg.Agents: config.Load drops
// disabled or removed agents from that map, so a per-agent loop would leave exactly
// those agents' templates un-normalized — still carrying models, still looking like
// a place the truth lives. Same reason the migration and the drift check enumerate
// workspaces from disk.
func (m *Manager) normalizeDiskTemplates() error {
	matches, err := filepath.Glob(filepath.Join(m.cfg.ContainerDataRoot, "templates", "*", "config.json"))
	if err != nil {
		return err
	}
	for _, path := range matches {
		if err := normalizeTemplateFile(path); err != nil {
			m.logf("normalize template %s: %v", path, err)
		}
	}
	return nil
}

func normalizeTemplateFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // nothing seeded yet; the embedded template is already empty
		}
		return err
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fmt.Errorf("parse: %w", err)
	}

	// Back up before the only destructive write the migration performs, and never
	// overwrite an existing backup: a re-run must not replace the real original
	// with an already-normalized copy.
	backup := path + ".pre-registry"
	if _, err := os.Stat(backup); os.IsNotExist(err) {
		if err := os.WriteFile(backup, raw, 0o600); err != nil {
			return fmt.Errorf("write backup: %w", err)
		}
	}

	cfg["model_list"] = []any{}
	if agents, ok := cfg["agents"].(map[string]any); ok {
		if defaults, ok := agents["defaults"].(map[string]any); ok {
			defaults["provider"] = ""
			defaults["model_name"] = ""
			delete(defaults, "model_fallbacks")
		}
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o600)
}

// checkModelDrift compares each workspace's config.json — its active model AND
// its fallback chain — against the recorded assignment, and logs mismatches.
//
// Read-only on purpose: a correction is an explicit admin reapply, never a
// boot-time surprise that changes which model someone's agent uses.
// It enumerates workspaces from DISK rather than from m.cfg.Agents, for the same
// reason the migration does: config.Load drops disabled or removed agents from that
// map, so a per-agent loop would silently stop reporting drift for exactly the
// workspaces most likely to have it.
func (m *Manager) checkModelDrift() {
	for _, key := range m.allExistingWorkspaces() {
		onDisk, chain, ok := readWorkspaceActiveModel(
			config.UserWorkspace(m.cfg.ContainerDataRoot, key.TenantID, key.SubsAccID, key.Role, key.UserAccID))
		if !ok {
			continue
		}
		a, err := m.reg.GetAssignment(m.workspaceRef(key))
		if err != nil {
			m.logf("model drift: workspace %+v runs %q but has no recorded assignment", key, onDisk)
			continue
		}
		if a.ModelName != onDisk {
			m.logf("model drift: workspace %+v runs %q, recorded %q", key, onDisk, a.ModelName)
			continue
		}
		if strings.Join(a.Chain, ",") != strings.Join(chain, ",") {
			m.logf("model drift: workspace %+v fallback chain on disk %v, recorded %v", key, chain, a.Chain)
		}
	}
}

// readWorkspaceActiveModel reports the primary and chain a workspace's config.json
// currently names.
func readWorkspaceActiveModel(userDir string) (primary string, chain []string, ok bool) {
	raw, err := os.ReadFile(filepath.Join(userDir, "config.json"))
	if err != nil {
		return "", nil, false
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", nil, false
	}
	agents, _ := cfg["agents"].(map[string]any)
	defaults, _ := agents["defaults"].(map[string]any)
	primary, _ = defaults["model_name"].(string)
	if primary == "" {
		return "", nil, false
	}
	if fb, ok := defaults["model_fallbacks"].([]any); ok {
		for _, v := range fb {
			if s, ok := v.(string); ok && s != "" {
				chain = append(chain, s)
			}
		}
	}
	return primary, chain, true
}
```

- [ ] **Step 4: Add normalization as the migration's last mutating step**

In `PROXY/internal/docker/migrate_models.go`, insert immediately before the `m.logf("migrate models: superseded files…")` line:

```go
	// 5. Normalize the disk templates LAST among the mutating steps. Not a data
	// dependency — it touches templates, step 4 touches workspaces — but ordering
	// it here means a failure anywhere earlier leaves the templates untouched and
	// the whole pass re-runnable.
	if err := m.normalizeDiskTemplates(); err != nil {
		return err
	}
```

- [ ] **Step 5: Wire both into Reconcile**

In `PROXY/internal/docker/reconcile.go`, immediately after the `func (m *Manager) Reconcile(ctx context.Context) error {` line, insert:

```go
	// The inventory must be seeded before anything resolves a model, and a
	// migration failure must stop the boot: continuing would provision workspaces
	// against an empty inventory and refuse every one of them.
	if err := m.migrateModelRegistry(); err != nil {
		return fmt.Errorf("migrate model registry: %w", err)
	}
	m.checkModelDrift()
```

Add `"fmt"` to `reconcile.go`'s imports if absent.

- [ ] **Step 6: Run the package tests**

Run: `cd PROXY && go test ./internal/docker/ -v 2>&1 | tail -30`
Expected: PASS — every `internal/docker` test.

- [ ] **Step 7: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/
git commit -m "feat(docker): normalize disk templates, wire migration and drift check into boot

A template that still carried models would remain a place the truth could appear
to live: an operator editing it would get no effect and no explanation, since
materialization overwrites model_list wholesale. Nothing in use is lost — the
migration already recovered every running model from the workspaces themselves.

Normalization is the migration's only destructive write, so it backs up to
config.json.pre-registry and never overwrites an existing backup (a re-run must
not replace the real original with a normalized copy).

The drift check is read-only: a correction is an explicit admin reapply, never a
boot-time surprise that changes which model someone's agent uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase C complete.** An existing deployment boots, imports its state, and no workspace's active model changes.

---

## Phase D — HTTP surface

### Task 13: the wire types and the inventory endpoints

**Files:**
- Create: `PROXY/internal/registry/public.go`
- Create: `PROXY/internal/registry/public_test.go`
- Create: `PROXY/internal/httpapi/admin_models.go`
- Create: `PROXY/internal/httpapi/admin_models_test.go`
- Modify: `PARENT/.specs/features/model-registry-source-of-truth/design.md` (§2, per the design correction at the top of this plan)

**Interfaces:**
- Consumes: Phase A + `docker.SuggestionCatalog`, `(*Manager).ReapplyModelForModel`.
- Produces:
  - `registry.PublicModel` — every `Model` field except `APIKey`, plus `has_key bool`, `in_use_count int`
  - `registry.Public(m Model, inUse int) PublicModel`
  - handlers `handleAdminModelsList`, `handleAdminModelCreate`, `handleAdminModelUpdate`, `handleAdminModelDelete`, `handleAdminModelDeprecate`, `handleAdminModelsReorder`, `handleAdminModelUsage`, `handleAdminModelCatalog`
  - `httpapi.registryErrStatus(err error) (int, any)` — maps registry errors to a status plus a body

- [ ] **Step 1: Write the failing test for the wire type**

Create `PROXY/internal/registry/public_test.go`:

```go
package registry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPublicModelCannotCarryAKey(t *testing.T) {
	m := Model{
		ModelName: "m", Provider: "openai", Model: "gpt-5.4",
		APIBase: "https://api.openai.com/v1", APIKey: "sk-super-secret",
		Status: StatusActive, Version: 3,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}

	raw, err := json.Marshal(Public(m, 2))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	// The wire type has no key field at all, so leaking one requires ADDING a
	// field rather than forgetting to strip one.
	if strings.Contains(string(raw), "sk-super-secret") || strings.Contains(string(raw), "api_key") {
		t.Fatalf("PublicModel leaked the key: %s", raw)
	}

	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out["has_key"] != true {
		t.Errorf("has_key = %#v, want true", out["has_key"])
	}
	if out["in_use_count"] != float64(2) {
		t.Errorf("in_use_count = %#v, want 2", out["in_use_count"])
	}
	if out["model_name"] != "m" || out["version"] != float64(3) {
		t.Errorf("public model = %#v", out)
	}
}

func TestPublicModelReportsNoKeyWhenAbsent(t *testing.T) {
	p := Public(Model{ModelName: "oauth", Provider: "antigravity", Model: "g", AuthMethod: "oauth"}, 0)
	if p.HasKey {
		t.Error("HasKey must be false when no key is stored")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/registry/ -run TestPublicModel -v`
Expected: FAIL — `undefined: Public`.

- [ ] **Step 3: Write the wire type**

Create `PROXY/internal/registry/public.go`:

```go
package registry

import (
	"encoding/json"
	"time"
)

// PublicModel is the client-facing shape of a Model. It has NO key field, so a
// handler cannot leak a credential by forgetting to strip one — leaking would
// require adding a field here on purpose.
type PublicModel struct {
	ModelName  string          `json:"model_name"`
	Provider   string          `json:"provider"`
	Model      string          `json:"model"`
	APIBase    string          `json:"api_base,omitempty"`
	AuthMethod string          `json:"auth_method,omitempty"`
	ExtraBody  json.RawMessage `json:"extra_body,omitempty"`

	Status     Status   `json:"status"`
	ReplacedBy string   `json:"replaced_by,omitempty"`
	Fallbacks  []string `json:"fallbacks"`
	Position   int      `json:"position"`

	// HasKey reports whether a credential is stored, which is all a client needs
	// to know to render the "key" badge.
	HasKey bool `json:"has_key"`
	// InUseCount drives the usage column and tells the admin up front why delete
	// and disable are unavailable.
	InUseCount int `json:"in_use_count"`

	ImportedOrphan bool `json:"imported_orphan,omitempty"`

	Version   uint64    `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Public converts a stored record for the wire. Fallbacks is emitted even when
// empty so a client can render the chain column without a null check.
func Public(m Model, inUse int) PublicModel {
	fallbacks := m.Fallbacks
	if fallbacks == nil {
		fallbacks = []string{}
	}
	return PublicModel{
		ModelName: m.ModelName, Provider: m.Provider, Model: m.Model,
		APIBase: m.APIBase, AuthMethod: m.AuthMethod, ExtraBody: m.ExtraBody,
		Status: m.Status, ReplacedBy: m.ReplacedBy, Fallbacks: fallbacks,
		Position: m.Position, HasKey: m.APIKey != "", InUseCount: inUse,
		ImportedOrphan: m.ImportedOrphan,
		Version:        m.Version, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt,
	}
}
```

- [ ] **Step 4: Run the wire-type tests**

Run: `cd PROXY && go test ./internal/registry/ -run TestPublicModel -v`
Expected: PASS — both.

- [ ] **Step 5: Write the failing handler test**

Create `PROXY/internal/httpapi/admin_models_test.go`. Read `PROXY/internal/httpapi/handlers_test.go` first and reuse its `Server` construction helper and profile-header fixtures — the names below assume a helper `newTestServer(t)` returning a `*Server` plus an admin and a non-admin profile header value. If those helpers are named differently, use the existing ones rather than adding parallel scaffolding.

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminModelsRequireProxyAdmin(t *testing.T) {
	s, _, nonAdmin := newTestServer(t)

	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/v1/admin/models", ""},
		{"POST", "/v1/admin/models", `{"model_name":"m","provider":"openai","model":"gpt-5.4","api_base":"https://x","api_key":"sk"}`},
		{"DELETE", "/v1/admin/models/m", ""},
		{"PUT", "/v1/admin/models/order", `{"order":["m"]}`},
		{"GET", "/v1/admin/model-catalog", ""},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set(profileHeaderName, nonAdmin)
		req.Header.Set("Authorization", testAgentBearer)
		req.Header.Set(serviceNameHeader, testServiceName)
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		// The inventory holds API keys with instance-wide blast radius, so the gate
		// is proxy-admin and it lives here, not only in the webapp.
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}

func TestAdminModelCreateListRoundTripNeverReturnsTheKey(t *testing.T) {
	s, admin, _ := newTestServer(t)

	body := `{"model_name":"gpt-5.4","provider":"openai","model":"gpt-5.4",
	  "api_base":"https://api.openai.com/v1","api_key":"sk-super-secret"}`
	rec := doAdmin(t, s, admin, "POST", "/v1/admin/models", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-super-secret") {
		t.Fatalf("create response leaked the key: %s", rec.Body.String())
	}

	rec = doAdmin(t, s, admin, "GET", "/v1/admin/models", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-super-secret") {
		t.Fatalf("list leaked the key: %s", rec.Body.String())
	}
	var listed struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Models) != 1 || listed.Models[0]["has_key"] != true {
		t.Errorf("listed = %#v, want one entry with has_key true", listed.Models)
	}
}

func TestAdminModelCreateDuplicateIsConflict(t *testing.T) {
	s, admin, _ := newTestServer(t)
	body := `{"model_name":"dup","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`
	if rec := doAdmin(t, s, admin, "POST", "/v1/admin/models", body); rec.Code != http.StatusOK {
		t.Fatalf("first create = %d", rec.Code)
	}
	rec := doAdmin(t, s, admin, "POST", "/v1/admin/models", body)
	if rec.Code != http.StatusConflict {
		t.Errorf("duplicate create = %d, want 409", rec.Code)
	}
}

func TestAdminModelUpdateStaleVersionIsConflict(t *testing.T) {
	s, admin, _ := newTestServer(t)
	create := `{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`
	doAdmin(t, s, admin, "POST", "/v1/admin/models", create)

	ok := doAdmin(t, s, admin, "PUT", "/v1/admin/models/m",
		`{"version":1,"provider":"openai","model":"m","api_base":"https://y"}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("update = %d: %s", ok.Code, ok.Body.String())
	}
	stale := doAdmin(t, s, admin, "PUT", "/v1/admin/models/m",
		`{"version":1,"provider":"openai","model":"m","api_base":"https://z"}`)
	if stale.Code != http.StatusConflict {
		t.Errorf("stale update = %d, want 409", stale.Code)
	}
}

func TestAdminModelUpdateOmittingTheKeyKeepsIt(t *testing.T) {
	s, admin, _ := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk-keep"}`)

	doAdmin(t, s, admin, "PUT", "/v1/admin/models/m",
		`{"version":1,"provider":"openai","model":"m","api_base":"https://y"}`)

	rec := doAdmin(t, s, admin, "GET", "/v1/admin/models", "")
	var listed struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	// A client that never receives the key must be able to edit other fields
	// without wiping it.
	if listed.Models[0]["has_key"] != true {
		t.Errorf("key lost on an update that omitted api_key: %#v", listed.Models[0])
	}
}

func TestAdminModelDeleteInUseReturnsTheReferrers(t *testing.T) {
	s, admin, _ := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"fb","provider":"openai","model":"fb","api_base":"https://x","api_key":"sk"}`)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"main","provider":"openai","model":"main","api_base":"https://x","api_key":"sk","fallbacks":["fb"]}`)

	rec := doAdmin(t, s, admin, "DELETE", "/v1/admin/models/fb", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete in use = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error     string `json:"error"`
		Referrers []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"referrers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// The rejection must name what to detach, or the admin has no next action.
	if len(body.Referrers) == 0 || body.Referrers[0].Kind != "fallback" || body.Referrers[0].ID != "main" {
		t.Errorf("referrers = %+v, want the fallback holder named", body.Referrers)
	}
}

func TestAdminModelDeprecateRequiresAReplacement(t *testing.T) {
	s, admin, _ := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"old","provider":"openai","model":"old","api_base":"https://x","api_key":"sk"}`)

	bad := doAdmin(t, s, admin, "POST", "/v1/admin/models/old/deprecate", `{"version":1}`)
	if bad.Code != http.StatusBadRequest {
		t.Errorf("deprecate without a replacement = %d, want 400", bad.Code)
	}

	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"new","provider":"openai","model":"new","api_base":"https://x","api_key":"sk"}`)
	good := doAdmin(t, s, admin, "POST", "/v1/admin/models/old/deprecate",
		`{"version":1,"replaced_by":"new"}`)
	if good.Code != http.StatusOK {
		t.Errorf("deprecate = %d: %s", good.Code, good.Body.String())
	}
}

func TestAdminModelCatalogReturnsSuggestionsWithoutKeys(t *testing.T) {
	s, admin, _ := newTestServer(t)
	rec := doAdmin(t, s, admin, "GET", "/v1/admin/model-catalog", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "api_key") {
		t.Errorf("catalog must never carry keys: %s", rec.Body.String())
	}
	var body struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) < 20 {
		t.Errorf("catalog has %d entries, want the full set", len(body.Entries))
	}
	// model_name is the admin's choice and must be unique, so suggesting one would
	// invite a duplicate.
	if _, present := body.Entries[0]["model_name"]; present {
		t.Errorf("catalog entry suggests a model_name: %#v", body.Entries[0])
	}
}

// doAdmin issues an authenticated admin request and returns the recorder.
func doAdmin(t *testing.T, s *Server, profile, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set(profileHeaderName, profile)
	req.Header.Set("Authorization", testAgentBearer)
	req.Header.Set(serviceNameHeader, testServiceName)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/httpapi/ -run TestAdminModel -v`
Expected: FAIL — `s.handleAdminModelsList undefined` and `s.Reg undefined`. The package itself compiled before this test was added (T10 removed the stale callers).

- [ ] **Step 7: Write the handlers**

Create `PROXY/internal/httpapi/admin_models.go`:

```go
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/docker"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// modelRequest is the create/update body. api_key is a POINTER so an update can
// distinguish "leave the stored key alone" (absent) from "clear it" (empty
// string) — a client never receives the key, so it must be able to edit other
// fields without wiping it.
type modelRequest struct {
	ModelName  string          `json:"model_name"`
	Provider   string          `json:"provider"`
	Model      string          `json:"model"`
	APIBase    string          `json:"api_base"`
	APIKey     *string         `json:"api_key"`
	AuthMethod string          `json:"auth_method"`
	ExtraBody  json.RawMessage `json:"extra_body"`
	Fallbacks  []string        `json:"fallbacks"`
	Version    uint64          `json:"version"`
}

// registryErrStatus maps a registry error to an HTTP status and a body. An in-use
// rejection carries the referrer list, because a bare 409 leaves the admin with
// no next action.
func registryErrStatus(err error) (int, any) {
	var inUse *registry.InUseError
	switch {
	case errors.As(err, &inUse):
		return http.StatusConflict, map[string]any{
			"error":     inUse.Error(),
			"referrers": inUse.Referrers,
		}
	case errors.Is(err, registry.ErrDuplicate):
		return http.StatusConflict, errBody(err.Error())
	case errors.Is(err, registry.ErrVersionConflict):
		return http.StatusConflict, map[string]any{
			"error":            err.Error(),
			"version_conflict": true,
		}
	case errors.Is(err, registry.ErrNotFound):
		return http.StatusNotFound, errBody(err.Error())
	case errors.Is(err, registry.ErrInvalid):
		return http.StatusBadRequest, errBody(err.Error())
	case errors.Is(err, registry.ErrNoModelResolvable):
		return http.StatusConflict, errBody(err.Error())
	}
	return http.StatusInternalServerError, errBody(err.Error())
}

// requireProxyAdmin resolves the caller and enforces the proxy-admin gate shared
// by every inventory operation. The inventory holds API keys whose blast radius is
// the whole instance, so a scope-level tier is not enough.
func (s *Server) requireProxyAdmin(w http.ResponseWriter, r *http.Request) bool {
	_, ident, ok := s.resolveSecretCaller(w, r)
	if !ok {
		return false
	}
	if !ident.Profile.HasAdminPrivileges() {
		writeJSON(w, http.StatusForbidden,
			errBody("admin privileges required to administer the model inventory"))
		return false
	}
	return true
}

func (s *Server) handleAdminModelsList(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	models, err := s.Reg.ListModels()
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	out := make([]registry.PublicModel, 0, len(models))
	for _, m := range models {
		refs, err := s.Reg.Referrers(m.ModelName)
		if err != nil {
			s.logf("admin models: referrers %q: %v", m.ModelName, err)
		}
		out = append(out, registry.Public(m, len(refs)))
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": out})
}

func (s *Server) handleAdminModelCreate(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	var req modelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	m := registry.Model{
		ModelName: req.ModelName, Provider: req.Provider, Model: req.Model,
		APIBase: req.APIBase, AuthMethod: req.AuthMethod, ExtraBody: req.ExtraBody,
		Fallbacks: req.Fallbacks, Status: registry.StatusActive,
	}
	if req.APIKey != nil {
		m.APIKey = *req.APIKey
	}
	created, err := s.Reg.CreateModel(m)
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"model": registry.Public(created, 0)})
}

func (s *Server) handleAdminModelUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	name := r.PathValue("name")
	var req modelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	updated, err := s.Reg.UpdateModel(name, req.Version, func(cur *registry.Model) error {
		cur.Provider = req.Provider
		cur.Model = req.Model
		cur.APIBase = req.APIBase
		cur.AuthMethod = req.AuthMethod
		cur.ExtraBody = req.ExtraBody
		cur.Fallbacks = req.Fallbacks
		// Absent api_key keeps the stored one; an explicit "" clears it.
		if req.APIKey != nil {
			cur.APIKey = *req.APIKey
		}
		return nil
	})
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	// A definition or key change must reach every workspace holding this model —
	// as primary OR as a chain member. Reaching only primaries would leave the
	// fallback holders on a stale credential.
	if err := s.Mgr.ReapplyModelForModel(name); err != nil {
		s.logf("admin models: reapply after updating %q: %v", name, err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"model": registry.Public(updated, 0)})
}

func (s *Server) handleAdminModelDelete(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	if err := s.Reg.DeleteModel(r.PathValue("name")); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

type statusRequest struct {
	Status     registry.Status `json:"status"`
	ReplacedBy string          `json:"replaced_by"`
	Version    uint64          `json:"version"`
}

func (s *Server) handleAdminModelStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	var req statusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	updated, err := s.Reg.SetStatus(r.PathValue("name"), req.Version, req.Status, req.ReplacedBy)
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"model": registry.Public(updated, 0)})
}

func (s *Server) handleAdminModelDeprecate(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	var req statusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	updated, err := s.Reg.Deprecate(r.PathValue("name"), req.Version, req.ReplacedBy)
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	// Deliberately no re-apply: existing users keeping the model is the point.
	writeJSON(w, http.StatusOK, map[string]any{"model": registry.Public(updated, 0)})
}

func (s *Server) handleAdminModelsReorder(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	var req struct {
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	if err := s.Reg.SetPositions(req.Order); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	// Deliberately no re-apply and no restart: position is presentation only.
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handleAdminModelUsage(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	refs, err := s.Reg.Referrers(r.PathValue("name"))
	if err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	if refs == nil {
		refs = []registry.Referrer{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"referrers": refs})
}

func (s *Server) handleAdminModelCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.requireProxyAdmin(w, r) {
		return
	}
	entries, err := docker.SuggestionCatalog()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}
```

- [ ] **Step 8: Add the `Reg` field to Server and register the routes**

In `PROXY/internal/httpapi/handlers.go`, add to the `Server` struct:

```go
	// Reg is the model inventory. Handlers read and write it directly; Mgr is
	// used only to make a change take effect on disk.
	Reg *registry.Registry
```

Replace the old route block at lines 211-219 with:

```go
	mux.HandleFunc("GET /v1/admin/models", s.handleAdminModelsList)
	mux.HandleFunc("POST /v1/admin/models", s.handleAdminModelCreate)
	mux.HandleFunc("PUT /v1/admin/models/order", s.handleAdminModelsReorder)
	mux.HandleFunc("PUT /v1/admin/models/{name}", s.handleAdminModelUpdate)
	mux.HandleFunc("DELETE /v1/admin/models/{name}", s.handleAdminModelDelete)
	mux.HandleFunc("PUT /v1/admin/models/{name}/status", s.handleAdminModelStatus)
	mux.HandleFunc("POST /v1/admin/models/{name}/deprecate", s.handleAdminModelDeprecate)
	mux.HandleFunc("GET /v1/admin/models/{name}/usage", s.handleAdminModelUsage)
	mux.HandleFunc("GET /v1/admin/model-catalog", s.handleAdminModelCatalog)
```

`PUT /v1/admin/models/order` is registered **before** `PUT /v1/admin/models/{name}`; Go's mux prefers the more specific literal pattern, but keeping them adjacent and ordered makes the intent obvious to the next reader.

Add the `registry` import to `handlers.go`, and pass `Reg: reg` wherever the `Server` is constructed in `PROXY/cmd/crab-shell-proxy/main.go`.

- [ ] **Step 9: Run the handler tests**

Run: `cd PROXY && go test ./internal/httpapi/ -run TestAdminModel -v`
Expected: PASS — all eight tests, and `go build ./...` clean: T10 already removed every
stale caller, so this task only adds.

- [ ] **Step 10: Fix design.md §2 per the correction**

In `PARENT/.specs/features/model-registry-source-of-truth/design.md` §2, replace the sentence

> `APIKey` is tagged `json:"-"` so the wire type cannot leak it by omission (NFR-4); persistence uses a separate internal struct that includes it. The API response type adds `has_key bool` and `in_use_count int`, both computed.

with

> `Model.APIKey` is tagged `json:"api_key,omitempty"` for storage, and a separate `PublicModel` (`internal/registry/public.go`) has **no key field at all** — handlers only ever marshal `PublicModel`, so leaking a key requires adding a field rather than forgetting to strip one (NFR-4). `PublicModel` adds `has_key bool` and `in_use_count int`, both computed.

- [ ] **Step 11: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/registry/public.go internal/registry/public_test.go internal/httpapi/
git commit -m "feat(httpapi): inventory endpoints behind the proxy-admin gate

PublicModel has no key field at all, so leaking a credential requires adding a
field rather than forgetting to strip one. api_key in the request body is a
pointer so an update can leave the stored key alone — a client never receives it
and must still be able to edit other fields.

An in-use 409 carries the referrer list: a bare conflict leaves the admin with no
next action. Updating a definition or key re-applies to chain holders too;
reorder and deprecate deliberately re-apply to nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: defaults and assignments, removal of the superseded routes

**Files:**
- Create: `PROXY/internal/httpapi/admin_model_scopes.go`
- Create: `PROXY/internal/httpapi/admin_model_scopes_test.go`
- Modify: `PROXY/internal/httpapi/admin.go` (delete the model-override handlers)
- Modify: `PROXY/internal/httpapi/handlers.go` (trim the `Docker` interface)
- Delete: `PROXY/internal/httpapi/admin_model_test.go`
- Modify: `PROXY/internal/httpapi/openapi.json`

**Interfaces:**
- Consumes: T13.
- Produces:
  - `handleAdminModelDefaultGet` / `Set` / `Clear`
  - `handleAdminModelAssignmentSet` / `Clear`
  - `httpapi.scopeSelFromQuery(get func(string) string) (registry.ScopeSel, error)`
- Removed from the `Docker` interface: `EffectiveModel`, `SetModelOverride`, `ClearModelOverride`. `ReapplyModelUser` loses its `agent config.Agent` parameter; `ReapplyModelForModel` is added.

- [ ] **Step 1: Write the failing test**

Create `PROXY/internal/httpapi/admin_model_scopes_test.go`:

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestModelDefaultGlobalAndAgentRequireProxyAdmin(t *testing.T) {
	s, _, nonAdmin := newTestServer(t)

	for _, path := range []string{
		"/v1/admin/model-defaults?scope=global",
		"/v1/admin/model-defaults?scope=agent",
	} {
		rec := doAdmin(t, s, nonAdmin, "PUT", path, `{"model_name":"m"}`)
		// global and agent are instance-wide, and AuthorizeSharedScope has no level
		// above tenant to express — so they take the proxy-admin gate.
		if rec.Code != http.StatusForbidden {
			t.Errorf("PUT %s as non-admin = %d, want 403", path, rec.Code)
		}
	}
}

func TestModelDefaultTenantUsesTheSharedScopeGate(t *testing.T) {
	s, admin, nonAdmin := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`)

	deny := doAdmin(t, s, nonAdmin, "PUT",
		"/v1/admin/model-defaults?scope=tenant&tenant_id="+testForeignTenantID, `{"model_name":"m"}`)
	if deny.Code != http.StatusForbidden {
		t.Errorf("tenant default for a foreign tenant = %d, want 403", deny.Code)
	}

	allow := doAdmin(t, s, admin, "PUT",
		"/v1/admin/model-defaults?scope=tenant&tenant_id="+testTenantID, `{"model_name":"m"}`)
	if allow.Code != http.StatusOK {
		t.Errorf("tenant default for an owned tenant = %d: %s", allow.Code, allow.Body.String())
	}
}

func TestModelDefaultRoundTripAndClear(t *testing.T) {
	s, admin, _ := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`)

	if rec := doAdmin(t, s, admin, "PUT", "/v1/admin/model-defaults?scope=global", `{"model_name":"m"}`); rec.Code != http.StatusOK {
		t.Fatalf("set = %d: %s", rec.Code, rec.Body.String())
	}
	rec := doAdmin(t, s, admin, "GET", "/v1/admin/model-defaults?scope=global", "")
	var body struct {
		Default *struct {
			ModelName string `json:"model_name"`
		} `json:"default"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Default == nil || body.Default.ModelName != "m" {
		t.Errorf("get = %s, want model m", rec.Body.String())
	}

	if rec := doAdmin(t, s, admin, "DELETE", "/v1/admin/model-defaults?scope=global", ""); rec.Code != http.StatusOK {
		t.Fatalf("clear = %d", rec.Code)
	}
	rec = doAdmin(t, s, admin, "GET", "/v1/admin/model-defaults?scope=global", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// An absent default is a null, not a 404: "no default here" is a normal state
	// the UI renders, not an error.
	if body.Default != nil {
		t.Errorf("cleared default = %s, want null", rec.Body.String())
	}
}

func TestModelDefaultRejectsAnInactiveModel(t *testing.T) {
	s, admin, _ := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`)
	doAdmin(t, s, admin, "PUT", "/v1/admin/models/m/status", `{"version":1,"status":"disabled"}`)

	rec := doAdmin(t, s, admin, "PUT", "/v1/admin/model-defaults?scope=global", `{"model_name":"m"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("disabled model as a default = %d, want 400", rec.Code)
	}
}

func TestModelAssignmentSetRequiresUserManagementAuthority(t *testing.T) {
	s, admin, nonAdmin := newTestServer(t)
	doAdmin(t, s, admin, "POST", "/v1/admin/models",
		`{"model_name":"m","provider":"openai","model":"m","api_base":"https://x","api_key":"sk"}`)

	body := `{"tenant_id":"` + testForeignTenantID + `","subs_acc_id":"` + testSubsAccID +
		`","user_acc_id":"` + testUserAccID + `","model_name":"m"}`
	rec := doAdmin(t, s, nonAdmin, "POST", "/v1/admin/model-assignments", body)
	if rec.Code != http.StatusForbidden {
		t.Errorf("assignment outside authority = %d, want 403", rec.Code)
	}
}

func TestModelAssignmentSetUnknownModelIs400(t *testing.T) {
	s, admin, _ := newTestServer(t)
	body := `{"tenant_id":"` + testTenantID + `","subs_acc_id":"` + testSubsAccID +
		`","user_acc_id":"` + testUserAccID + `","model_name":"ghost"}`
	rec := doAdmin(t, s, admin, "POST", "/v1/admin/model-assignments", body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown model = %d, want 400", rec.Code)
	}
}
```

Read `PROXY/internal/httpapi/handlers_test.go` and `admin_model_test.go` for the existing fixture constants (`testTenantID`, `testSubsAccID`, `testUserAccID`, and whichever value stands for a tenant the caller does **not** administer). Reuse them; add `testForeignTenantID` only if no equivalent exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/httpapi/ -run 'TestModelDefault|TestModelAssignment' -v`
Expected: FAIL — build errors plus missing handlers.

- [ ] **Step 3: Write the handlers**

Create `PROXY/internal/httpapi/admin_model_scopes.go`:

```go
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/authz"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/docker"
	"github.com/LepistaBioinformatics/crab-shell-proxy/internal/registry"
)

// scopeSelFromQuery parses ?scope=…&tenant_id=…&subs_acc_id=… into a ScopeSel.
// The agent level takes the agent from the ROUTED service, not a parameter, so a
// caller cannot address another agent's default through their own route.
func scopeSelFromQuery(get func(string) string, routedAgent string) (registry.ScopeSel, error) {
	switch scope := get("scope"); scope {
	case "global":
		return registry.ScopeSel{Level: registry.LevelGlobal}, nil
	case "agent":
		return registry.ScopeSel{Level: registry.LevelAgent, Agent: routedAgent}, nil
	case "tenant":
		return registry.ScopeSel{Level: registry.LevelTenant, TenantID: get("tenant_id")}, nil
	case "subscription":
		return registry.ScopeSel{
			Level: registry.LevelSubscription, TenantID: get("tenant_id"), SubsAccID: get("subs_acc_id"),
		}, nil
	default:
		return registry.ScopeSel{}, fmt.Errorf(`"scope" must be global, agent, tenant or subscription (got %q)`, scope)
	}
}

// authorizeScopeDefault gates a scope-default operation. global and agent are
// instance-wide, so they need proxy-admin: AuthorizeSharedScope has no level above
// tenant to express, and letting a tenant admin set them would hand them the whole
// instance.
func (s *Server) authorizeScopeDefault(w http.ResponseWriter, r *http.Request) (registry.ScopeSel, bool) {
	agent, ident, ok := s.resolveSecretCaller(w, r)
	if !ok {
		return registry.ScopeSel{}, false
	}
	sel, err := scopeSelFromQuery(r.URL.Query().Get, agent.Key)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(err.Error()))
		return registry.ScopeSel{}, false
	}
	switch sel.Level {
	case registry.LevelGlobal, registry.LevelAgent:
		if !ident.Profile.HasAdminPrivileges() {
			writeJSON(w, http.StatusForbidden,
				errBody("admin privileges required to set an instance-wide model default"))
			return registry.ScopeSel{}, false
		}
	default:
		if !authz.AuthorizeSharedScope(ident.Profile, string(sel.Level), sel.TenantID, sel.SubsAccID) {
			writeJSON(w, http.StatusForbidden, errBody("not authorized to administer this scope"))
			return registry.ScopeSel{}, false
		}
	}
	return sel, true
}

func (s *Server) handleAdminModelDefaultGet(w http.ResponseWriter, r *http.Request) {
	sel, ok := s.authorizeScopeDefault(w, r)
	if !ok {
		return
	}
	d, err := s.Reg.GetScopeDefault(sel)
	if err != nil {
		if errors.Is(err, registry.ErrNotFound) {
			// Absent is a normal state the UI renders, not an error.
			writeJSON(w, http.StatusOK, map[string]any{"default": nil})
			return
		}
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"default": d})
}

func (s *Server) handleAdminModelDefaultSet(w http.ResponseWriter, r *http.Request) {
	sel, ok := s.authorizeScopeDefault(w, r)
	if !ok {
		return
	}
	var req struct {
		ModelName string `json:"model_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return
	}
	if err := s.Reg.SetScopeDefault(sel, req.ModelName); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	s.reapplyForScope(sel)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handleAdminModelDefaultClear(w http.ResponseWriter, r *http.Request) {
	sel, ok := s.authorizeScopeDefault(w, r)
	if !ok {
		return
	}
	if err := s.Reg.ClearScopeDefault(sel); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	s.reapplyForScope(sel)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// reapplyForScope re-materializes the workspaces a scope-default change affects.
// A global or agent change has no docker.Scope to express, so it is left to each
// workspace's next start rather than sweeping the whole instance — a fleet-wide
// restart is not something a single admin click should trigger.
func (s *Server) reapplyForScope(sel registry.ScopeSel) {
	var scope docker.Scope
	switch sel.Level {
	case registry.LevelTenant:
		scope = docker.Scope{Kind: docker.ScopeTenant, TenantID: sel.TenantID}
	case registry.LevelSubscription:
		scope = docker.Scope{Kind: docker.ScopeSubscription, TenantID: sel.TenantID, SubsAccID: sel.SubsAccID}
	default:
		s.logf("model default %s changed: workspaces pick it up on their next start", sel.Level)
		return
	}
	if err := s.Mgr.ReapplyModelScope(scope); err != nil {
		s.logf("model default: reapply scope %+v: %v", scope, err)
	}
}

type modelAssignmentRequest struct {
	TenantID  string `json:"tenant_id"`
	SubsAccID string `json:"subs_acc_id"`
	UserAccID string `json:"user_acc_id"`
	ModelName string `json:"model_name"`
}

// resolveAssignmentTarget parses and authorizes a per-user assignment, reusing the
// same authority check every other per-user admin operation uses.
func (s *Server) resolveAssignmentTarget(w http.ResponseWriter, r *http.Request) (docker.WorkspaceKey, modelAssignmentRequest, bool) {
	agent, ident, ok := s.resolveSecretCaller(w, r)
	if !ok {
		return docker.WorkspaceKey{}, modelAssignmentRequest{}, false
	}
	var req modelAssignmentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("invalid JSON body"))
		return docker.WorkspaceKey{}, req, false
	}
	tenantID, err := uuid.Parse(req.TenantID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(`"tenant_id" is required and must be a UUID`))
		return docker.WorkspaceKey{}, req, false
	}
	subsAccID, err := uuid.Parse(req.SubsAccID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(`"subs_acc_id" is required and must be a UUID`))
		return docker.WorkspaceKey{}, req, false
	}
	userAccID, err := uuid.Parse(req.UserAccID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errBody(`"user_acc_id" is required and must be a UUID`))
		return docker.WorkspaceKey{}, req, false
	}
	if !authz.AuthorizeUserManagement(ident.Profile, tenantID.String(), subsAccID.String()) {
		writeJSON(w, http.StatusForbidden, errBody("not authorized to manage this user"))
		return docker.WorkspaceKey{}, req, false
	}
	return docker.WorkspaceKey{
		TenantID: tenantID.String(), SubsAccID: subsAccID.String(),
		Role: agent.Key, UserAccID: userAccID.String(),
	}, req, true
}

func (s *Server) handleAdminModelAssignmentSet(w http.ResponseWriter, r *http.Request) {
	key, req, ok := s.resolveAssignmentTarget(w, r)
	if !ok {
		return
	}
	m, err := s.Reg.GetModel(req.ModelName)
	if err != nil {
		if errors.Is(err, registry.ErrNotFound) {
			writeJSON(w, http.StatusBadRequest, errBody("model "+req.ModelName+" is not in the inventory"))
			return
		}
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	if m.Status == registry.StatusDisabled {
		writeJSON(w, http.StatusBadRequest,
			errBody("model "+req.ModelName+" is disabled and cannot be assigned"))
		return
	}
	if err := s.Mgr.SetModelAssignment(key, req.ModelName); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "model_name": req.ModelName})
}

func (s *Server) handleAdminModelAssignmentClear(w http.ResponseWriter, r *http.Request) {
	key, _, ok := s.resolveAssignmentTarget(w, r)
	if !ok {
		return
	}
	if err := s.Mgr.ClearModelAssignment(key); err != nil {
		status, body := registryErrStatus(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
```

- [ ] **Step 4: Add the two Manager methods the assignment handlers call**

Append to `PROXY/internal/docker/model.go`:

```go
// SetModelAssignment pins one workspace to a model and re-materializes it. The
// pin is EXPLICIT, which is what makes it survive later scope-default changes.
func (m *Manager) SetModelAssignment(key WorkspaceKey, modelName string) error {
	ref := m.workspaceRef(key)
	if err := m.reg.PutAssignment(ref, registry.Assignment{
		ModelName: modelName, Source: registry.SourceExplicit,
	}); err != nil {
		return err
	}
	return m.ReapplyModelUser(key)
}

// ClearModelAssignment drops a per-user pin so the workspace falls back to its
// scope default, then re-materializes it. The assignment is re-created as
// INHERITED by the re-materialization, which is how the inventory keeps knowing
// what this workspace runs.
func (m *Manager) ClearModelAssignment(key WorkspaceKey) error {
	if err := m.reg.DeleteAssignment(m.workspaceRef(key)); err != nil {
		return err
	}
	return m.ReapplyModelUser(key)
}
```

Add the `registry` import to `model.go`.

- [ ] **Step 5: Extend the Docker interface with the two assignment methods**

T10 already deleted the model-override handlers, their routes and the three
superseded interface methods, so this task only ADDS. In
`PROXY/internal/httpapi/handlers.go`, append to the `Docker` interface:

```go
	// SetModelAssignment pins one workspace to a model; ClearModelAssignment drops
	// the pin so the scope default applies again.
	SetModelAssignment(key docker.WorkspaceKey, modelName string) error
	ClearModelAssignment(key docker.WorkspaceKey) error
```

Register the new routes next to the T13 block:

```go
	mux.HandleFunc("GET /v1/admin/model-defaults", s.handleAdminModelDefaultGet)
	mux.HandleFunc("PUT /v1/admin/model-defaults", s.handleAdminModelDefaultSet)
	mux.HandleFunc("DELETE /v1/admin/model-defaults", s.handleAdminModelDefaultClear)
	mux.HandleFunc("POST /v1/admin/model-assignments", s.handleAdminModelAssignmentSet)
	mux.HandleFunc("DELETE /v1/admin/model-assignments", s.handleAdminModelAssignmentClear)
```

- [ ] **Step 6: Extend the fake Docker in the httpapi tests**

`PROXY/internal/httpapi/handlers_test.go` has a fake satisfying `Docker`, already
updated by T10. Add the two new methods:

```go
func (f *fakeDocker) SetModelAssignment(key docker.WorkspaceKey, modelName string) error {
	return f.reg.PutAssignment(registry.WorkspaceRef{
		TenantID: key.TenantID, SubsAccID: key.SubsAccID, Agent: key.Role, UserAccID: key.UserAccID,
	}, registry.Assignment{ModelName: modelName, Source: registry.SourceExplicit})
}
func (f *fakeDocker) ClearModelAssignment(key docker.WorkspaceKey) error {
	return f.reg.DeleteAssignment(registry.WorkspaceRef{
		TenantID: key.TenantID, SubsAccID: key.SubsAccID, Agent: key.Role, UserAccID: key.UserAccID,
	})
}
```

Give the fake a `reg *registry.Registry` field and have `newTestServer` open a registry in `t.TempDir()`, assign it to both `Server.Reg` and the fake, and close it via `t.Cleanup`. Use the same shape as `testRegistry` in `internal/registry/registry_test.go` but with `nil` for `now`.

- [ ] **Step 7: Update openapi.json**

In `PROXY/internal/httpapi/openapi.json`, remove the `/v1/admin/registered-models`, `/v1/admin/registered-models/apply`, `/v1/admin/model` and `/v1/admin/model/users` path entries, and add entries for the nine T13 routes plus the five above. Mirror the existing file's style: each path gets a `summary`, the security scheme the neighbouring admin paths use, and response codes 200/400/403/404/409 as applicable. No request or response schema may include an `api_key` **response** property; the create/update **request** bodies do include `api_key` (write-only) — mark them `"writeOnly": true`.

- [ ] **Step 7b: Verify the two Scope constants exist**

Run: `cd PROXY && grep -n "ScopeTenant\|ScopeSubscription" internal/docker/*.go | grep -v _test | head -5`
Expected: both `ScopeTenant` and `ScopeSubscription` are declared. If the tenant one is named differently, fix `reapplyForScope` to match rather than adding an alias.

- [ ] **Step 7c: Add the reorder test that asserts AC-19**

Append to `PROXY/internal/httpapi/admin_model_scopes_test.go`:

```go
func TestReorderDoesNotReapplyAnything(t *testing.T) {
	s, admin, _ := newTestServer(t)
	for _, n := range []string{"a", "b"} {
		doAdmin(t, s, admin, "POST", "/v1/admin/models",
			`{"model_name":"`+n+`","provider":"openai","model":"`+n+`","api_base":"https://x","api_key":"sk"}`)
	}

	rec := doAdmin(t, s, admin, "PUT", "/v1/admin/models/order", `{"order":["b","a"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("reorder = %d: %s", rec.Code, rec.Body.String())
	}
	// Position is presentation only. A drag must not re-materialize or restart
	// anything, so the fake must have recorded no reapply call at all.
	if n := s.Mgr.(*fakeDocker).reapplyCalls; n != 0 {
		t.Errorf("reorder triggered %d reapply calls, want 0", n)
	}
}
```

Give `fakeDocker` a `reapplyCalls int` field and increment it in `ReapplyModelForModel`, `ReapplyModelScope` and `ReapplyModelUser`. If `Server.Mgr` is typed as the `Docker` interface, the type assertion above works; if it is a concrete type, keep a package-level pointer to the fake from `newTestServer` instead.

- [ ] **Step 8: Run the whole suite**

Run: `cd PROXY && go build ./... && go vet ./... && go test ./... 2>&1 | tail -30`
Expected: PASS across every package, as at every task boundary since T10.

- [ ] **Step 9: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add -A internal/httpapi/
git commit -m "feat(httpapi): scope defaults and per-user assignments; drop the old model routes

global and agent defaults take the proxy-admin gate because they are
instance-wide and AuthorizeSharedScope has no level above tenant to express;
tenant and subscription keep the shared-scope check, and per-user assignment
keeps the user-management check.

The agent level takes its agent from the ROUTED service rather than a parameter,
so a caller cannot address another agent's default through their own route. A
global or agent change is left to each workspace's next start: a fleet-wide
restart is not something one admin click should trigger.

Removes /v1/admin/registered-models*, /v1/admin/model and /v1/admin/model/users,
and trims the Docker interface accordingly. Nothing called them — the
admin-model-override UI its FR-6 specified was never built.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: repoint the native model-secret slot at the inventory

**Files:**
- Modify: `PROXY/internal/docker/secrets.go:168-200` (`validateNativeSlot`)
- Modify: `PROXY/internal/docker/secrets_test.go`
- Modify: `PROXY/internal/docker/manager.go:546` (`workspaceSecurityPath`, if it exists only for this validation)

**Interfaces:**
- Consumes: T01–T14.
- Produces: `validateNativeSlot` gains a `models modelNameChecker` parameter; `type modelNameChecker interface { GetModel(string) (registry.Model, error) }`.

- [ ] **Step 1: Write the failing test**

Add to `PROXY/internal/docker/secrets_test.go`:

```go
func TestValidateNativeSlotChecksModelsAgainstTheInventory(t *testing.T) {
	at := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	reg, err := registry.Open(filepath.Join(t.TempDir(), "r.db"), func() time.Time { return at })
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	if _, err := reg.CreateModel(registry.Model{
		ModelName: "known", Provider: "openai", Model: "known",
		APIBase: "https://x", APIKey: "sk", Status: registry.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}

	// A model in the inventory is accepted, so a selected model never fails
	// validation.
	if err := validateNativeSlot(reg, "model_list.known.api_keys"); err != nil {
		t.Errorf("known model rejected: %v", err)
	}
	// One that is not is rejected: the inventory is the only place a model exists,
	// so accepting an unknown name would key a credential nothing reads.
	if err := validateNativeSlot(reg, "model_list.ghost.api_keys"); !errors.Is(err, ErrUnknownNativeSlot) {
		t.Errorf("unknown model = %v, want ErrUnknownNativeSlot", err)
	}
	// The web family is unchanged.
	if err := validateNativeSlot(reg, "web.brave"); err != nil {
		t.Errorf("web.brave rejected: %v", err)
	}
	if err := validateNativeSlot(reg, "web.nonsense"); !errors.Is(err, ErrUnknownNativeSlot) {
		t.Errorf("unknown web provider = %v, want ErrUnknownNativeSlot", err)
	}
	// The proxy<->picoclaw channel token must stay unreachable.
	if err := validateNativeSlot(reg, "channel_list.pico.settings.token"); !errors.Is(err, ErrUnknownNativeSlot) {
		t.Errorf("pico token slot = %v, want ErrUnknownNativeSlot", err)
	}
}
```

Add `"errors"`, `"path/filepath"`, `"time"` and the `registry` import to the file if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd PROXY && go test ./internal/docker/ -run TestValidateNativeSlot -v`
Expected: FAIL — `too many arguments in call to validateNativeSlot`.

- [ ] **Step 3: Rewrite validateNativeSlot**

Replace `validateNativeSlot` in `PROXY/internal/docker/secrets.go` with:

```go
// modelNameChecker is the slice of the registry this validation needs. Taking an
// interface keeps secrets.go testable without a Manager and documents that the
// only question being asked is "does this model exist".
type modelNameChecker interface {
	GetModel(name string) (registry.Model, error)
}

// validateNativeSlot accepts only two families: web.<provider> from the fixed
// enum, and model_list.<model>.api_keys where the model exists in the INVENTORY.
// Everything else — notably channel_list.pico.settings.token, the
// proxy<->picoclaw auth token — is rejected so a user can never overwrite it.
//
// The model check reads the inventory rather than a template's .security.yml: the
// inventory is now the only place a model exists, so a name it does not know would
// key a credential nothing reads. A model registered through the admin UI
// therefore always passes, and a typo never does.
//
// A slot that passes becomes a scope-level OVERLAY over the inventory's own key:
// applyNativeSecrets runs after materialization, so a scope admin can supply their
// own credential for a registered model. That is a layered override with defined
// precedence, not a second writer.
func validateNativeSlot(models modelNameChecker, slot string) error {
	parts := strings.Split(slot, ".")
	switch {
	case len(parts) == 2 && parts[0] == "web":
		if webProviders[parts[1]] {
			return nil
		}
		return fmt.Errorf("%w: unknown web provider %q", ErrUnknownNativeSlot, parts[1])
	case len(parts) == 3 && parts[0] == "model_list" && parts[2] == "api_keys":
		if _, err := models.GetModel(parts[1]); err != nil {
			return fmt.Errorf("%w: model %q is not in the model inventory", ErrUnknownNativeSlot, parts[1])
		}
		return nil
	}
	return fmt.Errorf("%w: %q", ErrUnknownNativeSlot, slot)
}
```

Add the `registry` import to `secrets.go`.

- [ ] **Step 4: Update the two call sites**

The call at `PROXY/internal/docker/secrets.go:81` is inside a function reached from a `Manager` method. Thread the checker through: change the enclosing `upsertSecret`/`setSecret` function to take a `models modelNameChecker` first parameter, pass `m.reg` from the `Manager` method that calls it, and replace

```go
		if err := validateNativeSlot(secPath, name); err != nil {
```

with

```go
		if err := validateNativeSlot(models, name); err != nil {
```

Run `cd PROXY && go build ./internal/docker/ 2>&1 | head -20` and thread the parameter through each reported call site until it compiles. Then delete `workspaceSecurityPath` (`manager.go:546`) if the compiler reports it as unused — its only purpose was this validation.

- [ ] **Step 5: Run the suite**

Run: `cd PROXY && go build ./... && go vet ./... && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add internal/docker/
git commit -m "feat(docker): native model-secret slots validate against the inventory

The slot used to be checked against a template's .security.yml. The inventory is
now the only place a model exists, so a name it does not know would key a
credential nothing reads. A model registered through the admin UI always passes
and a typo never does.

A passing slot remains a scope-level OVERLAY over the inventory key —
applyNativeSecrets runs after materialization — so a scope admin can still supply
their own credential for a registered model. Layered override with defined
precedence, not a second writer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase E — Gateway

### Task 16: register the new admin paths in the mycelium allowlist

**Files:**
- Modify: `PARENT/fungi/mycelium/config.base.toml`
- Modify: `PARENT/fungi/mycelium/config.standalone.toml`

**Interfaces:**
- Consumes: T13, T14 route paths.
- Produces: nothing in code — this is deploy-blocking configuration.

- [ ] **Step 1: Inspect the existing block to copy its exact shape**

Run:

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
grep -n "registered-models" -B 2 -A 6 fungi/mycelium/config.base.toml
```

Expected: two `[[picoclaw-alpha.path]]` blocks and two `[[picoclaw-beta.path]]` blocks, each with `group`, `path`, `secretName`, `acceptInsecureRouting` and `methods`.

- [ ] **Step 2: Replace them, for both services, in both files**

For each of `picoclaw-alpha` and `picoclaw-beta`, in **both** `config.base.toml` and `config.standalone.toml`: delete the `registered-models`, `registered-models/apply`, `/v1/admin/model` and `/v1/admin/model/users` path blocks, and add (substituting the service name in `secretName`):

```toml
[[picoclaw-alpha.path]]
group = "protected"
path = "/v1/admin/models"
secretName = "picoclaw-alpha-authorization-header"
acceptInsecureRouting = true
methods = ["GET", "POST"]

[[picoclaw-alpha.path]]
group = "protected"
path = "/v1/admin/models/order"
secretName = "picoclaw-alpha-authorization-header"
acceptInsecureRouting = true
methods = ["PUT"]

[[picoclaw-alpha.path]]
group = "protected"
path = "/v1/admin/model-catalog"
secretName = "picoclaw-alpha-authorization-header"
acceptInsecureRouting = true
methods = ["GET"]

[[picoclaw-alpha.path]]
group = "protected"
path = "/v1/admin/model-defaults"
secretName = "picoclaw-alpha-authorization-header"
acceptInsecureRouting = true
methods = ["GET", "PUT", "DELETE"]

[[picoclaw-alpha.path]]
group = "protected"
path = "/v1/admin/model-assignments"
secretName = "picoclaw-alpha-authorization-header"
acceptInsecureRouting = true
methods = ["POST", "DELETE"]
```

- [ ] **Step 3: Determine how the gateway matches the per-model paths**

`PUT /v1/admin/models/{name}`, `DELETE /v1/admin/models/{name}`, `PUT /v1/admin/models/{name}/status`, `POST /v1/admin/models/{name}/deprecate` and `GET /v1/admin/models/{name}/usage` carry a variable segment. Check whether the existing config uses prefix matching:

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
grep -n "path = " fungi/mycelium/config.base.toml | head -40
```

If any existing entry covers sub-paths (e.g. a `/v1/admin/shared-skills` entry serving `/v1/admin/shared-skills/<name>`), then `path = "/v1/admin/models"` already covers the variable-segment routes and Step 2 is sufficient — record that in the commit message.

If matching is exact, add one block per literal shape the UI calls, using a placeholder segment consistent with whatever the existing config does for `shared-skills`. If nothing in the file demonstrates a variable segment, **stop and ask the user** rather than guessing: an unroutable admin path fails as "Request path does not match any service", which looks like a proxy bug and would be diagnosed in the wrong repo.

- [ ] **Step 4: Verify both files still parse**

Run:

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
python3 -c "import tomllib,sys
for p in ['fungi/mycelium/config.base.toml','fungi/mycelium/config.standalone.toml']:
    tomllib.load(open(p,'rb')); print(p,'ok')"
```

Expected: `ok` for both.

- [ ] **Step 5: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
git add fungi/mycelium/config.base.toml fungi/mycelium/config.standalone.toml
git commit -m "feat(gateway): allow the model inventory admin paths

Registers /v1/admin/models*, /v1/admin/model-catalog, /v1/admin/model-defaults
and /v1/admin/model-assignments for both picoclaw services, and drops the
superseded registered-models and model-override entries.

Deploy-blocking and requires a gateway reload: without it the gateway answers
'Request path does not match any service', which reads as a proxy bug and gets
diagnosed in the wrong repo. Precedent: c89570c.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phases D and E complete.** The proxy compiles, its whole suite passes, and the new admin surface is reachable through the gateway.

---

## Phase F — Webapp

### Task 17: `lib/models.ts` — types, calls and the pure helpers the UI needs

**Files:**
- Create: `WEBAPP/lib/models.ts`
- Create: `WEBAPP/lib/models.test.ts`
- Delete: `WEBAPP/lib/registeredModels.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the BFF routes arrive in T18; these calls target them).
- Produces:
  - types `ModelStatus`, `InventoryModel`, `CatalogEntry`, `Referrer`, `ScopeDefault`, `ModelDraft`
  - `splitInventory(models) => { active, inactive }`
  - `draftFromCatalog(entry) => ModelDraft`
  - `draftFromDuplicate(model) => ModelDraft`
  - `inactiveReason(model) => string`
  - `modelsApiError(res) => Promise<ModelsError>` where `ModelsError = { message: string; versionConflict: boolean; referrers: Referrer[] }`
  - calls `listModels`, `createModel`, `updateModel`, `deleteModel`, `setModelStatus`, `deprecateModel`, `reorderModels`, `modelUsage`, `modelCatalog`, `getModelDefault`, `setModelDefault`, `clearModelDefault`, `setModelAssignment`, `clearModelAssignment`

- [ ] **Step 1: Write the failing test**

Create `WEBAPP/lib/models.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  splitInventory,
  draftFromCatalog,
  draftFromDuplicate,
  inactiveReason,
  modelsApiError,
} from "./models";
import type { InventoryModel } from "./models";

function model(over: Partial<InventoryModel> = {}): InventoryModel {
  return {
    model_name: "m",
    provider: "openai",
    model: "gpt-5.4",
    api_base: "https://api.openai.com/v1",
    status: "active",
    fallbacks: [],
    position: 1,
    has_key: true,
    in_use_count: 0,
    version: 1,
    created_at: "2026-07-25T12:00:00Z",
    updated_at: "2026-07-25T12:00:00Z",
    ...over,
  };
}

describe("splitInventory", () => {
  it("separates active from disabled and deprecated", () => {
    const { active, inactive } = splitInventory([
      model({ model_name: "a", status: "active", position: 2 }),
      model({ model_name: "b", status: "disabled", position: 1 }),
      model({ model_name: "c", status: "deprecated", replaced_by: "a", position: 3 }),
    ]);
    expect(active.map((m) => m.model_name)).toEqual(["a"]);
    expect(inactive.map((m) => m.model_name)).toEqual(["b", "c"]);
  });

  it("orders the active group by position", () => {
    const { active } = splitInventory([
      model({ model_name: "second", position: 2 }),
      model({ model_name: "first", position: 1 }),
    ]);
    expect(active.map((m) => m.model_name)).toEqual(["first", "second"]);
  });

  it("returns empty groups for an empty inventory rather than throwing", () => {
    expect(splitInventory([])).toEqual({ active: [], inactive: [] });
  });
});

describe("inactiveReason", () => {
  it("names the replacement for a deprecated model", () => {
    expect(inactiveReason(model({ status: "deprecated", replaced_by: "successor" }))).toBe(
      "deprecated → replaced by successor",
    );
  });

  it("labels a disabled model", () => {
    expect(inactiveReason(model({ status: "disabled" }))).toBe("disabled");
  });

  it("says nothing for an active model", () => {
    expect(inactiveReason(model())).toBe("");
  });
});

describe("draftFromCatalog", () => {
  it("prefills provider, model and api_base and leaves the name and key blank", () => {
    const draft = draftFromCatalog({
      provider: "zhipu",
      model: "glm-4.7",
      api_base: "https://open.bigmodel.cn/api/paas/v4",
    });
    expect(draft.provider).toBe("zhipu");
    expect(draft.model).toBe("glm-4.7");
    expect(draft.api_base).toBe("https://open.bigmodel.cn/api/paas/v4");
    // The catalog deliberately suggests no model_name: it must be unique in the
    // inventory, so a suggested one would invite a duplicate.
    expect(draft.model_name).toBe("");
    expect(draft.api_key).toBe("");
  });

  it("carries auth_method for a catalog entry that has no api_base", () => {
    const draft = draftFromCatalog({ provider: "antigravity", model: "gemini-3-flash", auth_method: "oauth" });
    expect(draft.auth_method).toBe("oauth");
    expect(draft.api_base).toBe("");
  });
});

describe("draftFromDuplicate", () => {
  it("copies every field except the name and the key", () => {
    const draft = draftFromDuplicate(
      model({ model_name: "original", api_base: "https://x/v1", fallbacks: ["fb"], auth_method: "oauth" }),
    );
    expect(draft.provider).toBe("openai");
    expect(draft.api_base).toBe("https://x/v1");
    expect(draft.auth_method).toBe("oauth");
    expect(draft.fallbacks).toEqual(["fb"]);
    // The name must be unique, and the key is never returned by the API — so both
    // are blank and the admin has to supply them.
    expect(draft.model_name).toBe("");
    expect(draft.api_key).toBe("");
  });
});

describe("modelsApiError", () => {
  it("flags a version conflict so the UI can say reload", async () => {
    const res = new Response(JSON.stringify({ error: "stale", version_conflict: true }), { status: 409 });
    const err = await modelsApiError(res);
    expect(err.versionConflict).toBe(true);
  });

  it("surfaces the referrers of an in-use rejection", async () => {
    const res = new Response(
      JSON.stringify({ error: "in use", referrers: [{ kind: "fallback", id: "main" }] }),
      { status: 409 },
    );
    const err = await modelsApiError(res);
    expect(err.versionConflict).toBe(false);
    expect(err.referrers).toEqual([{ kind: "fallback", id: "main" }]);
  });

  it("maps the stack-wide error shapes", async () => {
    const conn = await modelsApiError(new Response(JSON.stringify({ error: "connectivity" }), { status: 502 }));
    expect(conn.message).toBe("Can't reach the gateway right now.");
    const expired = await modelsApiError(
      new Response(JSON.stringify({ error: "session_expired" }), { status: 401 }),
    );
    expect(expired.message).toBe("Your session expired — sign in again.");
  });

  it("falls back to a generic message on an unparseable body", async () => {
    const err = await modelsApiError(new Response("<html>500</html>", { status: 500 }));
    expect(err.message).toBe("Something went wrong.");
    expect(err.referrers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd WEBAPP && yarn vitest run lib/models.test.ts`
Expected: FAIL — cannot resolve `./models`.

- [ ] **Step 3: Write the implementation**

Create `WEBAPP/lib/models.ts`:

```ts
import type { Instance } from "@/lib/mycelium";

export type ModelStatus = "active" | "disabled" | "deprecated";

// InventoryModel mirrors the proxy's PublicModel. There is deliberately no
// api_key field: the API never returns one.
export interface InventoryModel {
  model_name: string;
  provider: string;
  model: string;
  api_base?: string;
  auth_method?: string;
  extra_body?: unknown;
  status: ModelStatus;
  replaced_by?: string;
  fallbacks: string[];
  position: number;
  has_key: boolean;
  in_use_count: number;
  imported_orphan?: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

// CatalogEntry is a prefill suggestion. It carries no key and no model_name.
export interface CatalogEntry {
  provider: string;
  model: string;
  api_base?: string;
  auth_method?: string;
  extra_body?: unknown;
}

export interface Referrer {
  kind: "workspace" | "scope_default" | "replaced_by" | "fallback";
  id: string;
}

export interface ScopeDefault {
  model_name: string;
  updated_at: string;
}

// ModelDraft is the register/edit form's state. api_key is write-only: it is sent
// when non-empty and never populated from a response.
export interface ModelDraft {
  model_name: string;
  provider: string;
  model: string;
  api_base: string;
  auth_method: string;
  api_key: string;
  fallbacks: string[];
}

// A factory, not a shared const: a shared object would hand every draft the SAME
// fallbacks array, so editing one form's chain would mutate the template.
export function emptyDraft(): ModelDraft {
  return {
    model_name: "",
    provider: "",
    model: "",
    api_base: "",
    auth_method: "",
    api_key: "",
    fallbacks: [],
  };
}

// splitInventory groups the listing the way the panel renders it. The active group
// is ordered by position, which is PRESENTATION ONLY — it is not the fallback
// chain, and the UI must not imply otherwise.
export function splitInventory(models: InventoryModel[]): {
  active: InventoryModel[];
  inactive: InventoryModel[];
} {
  const active = models.filter((m) => m.status === "active").sort((a, b) => a.position - b.position);
  const inactive = models
    .filter((m) => m.status !== "active")
    .sort((a, b) => a.position - b.position);
  return { active, inactive };
}

// inactiveReason is the badge text for the inactive group. Deprecated names its
// replacement, because "where do new users go instead" is the first thing an admin
// looking at a retired model needs to know.
export function inactiveReason(m: InventoryModel): string {
  if (m.status === "deprecated") {
    return `deprecated → replaced by ${m.replaced_by ?? "?"}`;
  }
  if (m.status === "disabled") {
    return "disabled";
  }
  return "";
}

export function draftFromCatalog(entry: CatalogEntry): ModelDraft {
  return {
    ...emptyDraft(),
    provider: entry.provider,
    model: entry.model,
    api_base: entry.api_base ?? "",
    auth_method: entry.auth_method ?? "",
  };
}

// draftFromDuplicate copies an existing entry for editing. model_name is blank
// because it must be unique, and api_key because the API never returns it.
export function draftFromDuplicate(m: InventoryModel): ModelDraft {
  return {
    model_name: "",
    provider: m.provider,
    model: m.model,
    api_base: m.api_base ?? "",
    auth_method: m.auth_method ?? "",
    api_key: "",
    fallbacks: [...m.fallbacks],
  };
}

export interface ModelsError {
  message: string;
  versionConflict: boolean;
  referrers: Referrer[];
}

// modelsApiError turns a failed response into something the panel can render
// specifically: a stale version says "reload", an in-use rejection names what to
// detach. A generic conflict message would leave the admin with no next action.
export async function modelsApiError(res: Response): Promise<ModelsError> {
  const data = await res.json().catch(() => null);
  const referrers: Referrer[] = Array.isArray(data?.referrers) ? data.referrers : [];
  const versionConflict = data?.version_conflict === true;
  const e = data?.error;
  let message = "Something went wrong.";
  if (e === "connectivity") {
    message = "Can't reach the gateway right now.";
  } else if (e === "session_expired") {
    message = "Your session expired — sign in again.";
  } else if (versionConflict) {
    message = "Another admin changed this model — reload before saving.";
  } else if (typeof e === "string" && e.trim()) {
    message = e;
  }
  return { message, versionConflict, referrers };
}

// request throws an Error carrying the ModelsError fields, so a caller can render
// a version conflict or an in-use referrer list without a second round trip.
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  if (!res.ok) {
    throw Object.assign(new Error("request failed"), await modelsApiError(res));
  }
  return res.json().catch(() => ({}));
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const q = (agent: Instance, extra: Record<string, string> = {}) =>
  new URLSearchParams({ agent, ...extra }).toString();

export async function listModels(agent: Instance): Promise<InventoryModel[]> {
  const data = (await request(`/api/admin/models?${q(agent)}`)) as { models?: InventoryModel[] };
  return Array.isArray(data.models) ? data.models : [];
}

export async function modelCatalog(agent: Instance): Promise<CatalogEntry[]> {
  const data = (await request(`/api/admin/model-catalog?${q(agent)}`)) as { entries?: CatalogEntry[] };
  return Array.isArray(data.entries) ? data.entries : [];
}

export async function createModel(agent: Instance, draft: ModelDraft): Promise<void> {
  await request("/api/admin/models", json({ agent, ...serializeDraft(draft) }));
}

export async function updateModel(agent: Instance, name: string, version: number, draft: ModelDraft): Promise<void> {
  await request(`/api/admin/models?${q(agent, { name })}`, {
    ...json({ agent, name, version, ...serializeDraft(draft) }),
    method: "PUT",
  });
}

// serializeDraft omits api_key when blank, so an edit that does not touch the key
// keeps the stored one instead of clearing it.
function serializeDraft(draft: ModelDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model_name: draft.model_name,
    provider: draft.provider,
    model: draft.model,
    api_base: draft.api_base,
    auth_method: draft.auth_method,
    fallbacks: draft.fallbacks,
  };
  if (draft.api_key) {
    body.api_key = draft.api_key;
  }
  return body;
}

export async function deleteModel(agent: Instance, name: string): Promise<void> {
  await request(`/api/admin/models?${q(agent, { name })}`, { method: "DELETE" });
}

export async function setModelStatus(
  agent: Instance,
  name: string,
  version: number,
  status: ModelStatus,
): Promise<void> {
  await request(`/api/admin/models/status?${q(agent, { name })}`, {
    ...json({ agent, name, version, status }),
    method: "PUT",
  });
}

export async function deprecateModel(
  agent: Instance,
  name: string,
  version: number,
  replacedBy: string,
): Promise<void> {
  await request("/api/admin/models/deprecate", json({ agent, name, version, replaced_by: replacedBy }));
}

export async function reorderModels(agent: Instance, order: string[]): Promise<void> {
  await request("/api/admin/models/order", { ...json({ agent, order }), method: "PUT" });
}

export async function modelUsage(agent: Instance, name: string): Promise<Referrer[]> {
  const data = (await request(`/api/admin/models/usage?${q(agent, { name })}`)) as {
    referrers?: Referrer[];
  };
  return Array.isArray(data.referrers) ? data.referrers : [];
}

export type DefaultScope =
  | { kind: "global" }
  | { kind: "agent" }
  | { kind: "tenant"; tenantId: string }
  | { kind: "subscription"; tenantId: string; subsAccId: string };

function defaultScopeQuery(agent: Instance, scope: DefaultScope): string {
  const extra: Record<string, string> = { scope: scope.kind };
  if (scope.kind === "tenant" || scope.kind === "subscription") {
    extra.tenant_id = scope.tenantId;
  }
  if (scope.kind === "subscription") {
    extra.subs_acc_id = scope.subsAccId;
  }
  return q(agent, extra);
}

export async function getModelDefault(agent: Instance, scope: DefaultScope): Promise<ScopeDefault | null> {
  const data = (await request(`/api/admin/model-defaults?${defaultScopeQuery(agent, scope)}`)) as {
    default?: ScopeDefault | null;
  };
  return data.default ?? null;
}

export async function setModelDefault(agent: Instance, scope: DefaultScope, modelName: string): Promise<void> {
  await request(`/api/admin/model-defaults?${defaultScopeQuery(agent, scope)}`, {
    ...json({ agent, model_name: modelName }),
    method: "PUT",
  });
}

export async function clearModelDefault(agent: Instance, scope: DefaultScope): Promise<void> {
  await request(`/api/admin/model-defaults?${defaultScopeQuery(agent, scope)}`, { method: "DELETE" });
}

export interface AssignmentTarget {
  tenantId: string;
  subsAccId: string;
  userAccId: string;
}

export async function setModelAssignment(
  agent: Instance,
  target: AssignmentTarget,
  modelName: string,
): Promise<void> {
  await request(
    "/api/admin/model-assignments",
    json({
      agent,
      tenant_id: target.tenantId,
      subs_acc_id: target.subsAccId,
      user_acc_id: target.userAccId,
      model_name: modelName,
    }),
  );
}

export async function clearModelAssignment(agent: Instance, target: AssignmentTarget): Promise<void> {
  await request("/api/admin/model-assignments", {
    ...json({
      agent,
      tenant_id: target.tenantId,
      subs_acc_id: target.subsAccId,
      user_acc_id: target.userAccId,
    }),
    method: "DELETE",
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd WEBAPP && yarn vitest run lib/models.test.ts`
Expected: PASS — all 14 assertions across the five describes.

- [ ] **Step 5: Delete the superseded module**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git rm lib/registeredModels.ts
```

`tsc` will now flag `app/admin/model-registry-panel.tsx`; T19 rewrites it. Do not patch it here.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git add lib/models.ts lib/models.test.ts
git commit -m "feat(models): inventory client and the pure helpers the panel needs

The panel's logic lives in tested pure functions rather than inside a client
component: splitInventory, inactiveReason, the two draft builders and the error
mapper. serializeDraft omits api_key when blank so an edit that does not touch the
key keeps the stored one — the API never returns it, so the form cannot round-trip
it. modelsApiError distinguishes a stale version (reload) from an in-use rejection
(detach these), because a generic conflict leaves the admin with no next action.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 18: BFF routes

**Files:**
- Create: `WEBAPP/app/api/admin/models/route.ts`
- Create: `WEBAPP/app/api/admin/models/status/route.ts`
- Create: `WEBAPP/app/api/admin/models/deprecate/route.ts`
- Create: `WEBAPP/app/api/admin/models/order/route.ts`
- Create: `WEBAPP/app/api/admin/models/usage/route.ts`
- Create: `WEBAPP/app/api/admin/model-catalog/route.ts`
- Create: `WEBAPP/app/api/admin/model-defaults/route.ts`
- Create: `WEBAPP/app/api/admin/model-assignments/route.ts`
- Delete: `WEBAPP/app/api/admin/registered-models/route.ts`, `WEBAPP/app/api/admin/registered-models/apply/route.ts`

**Interfaces:**
- Consumes: `proxyAdminJsonAgent`, `requireSession` (`lib/adminProxy.ts`), `isInstance` (`lib/mycelium.ts`).
- Produces: the eight routes `lib/models.ts` calls.

- [ ] **Step 1: Write the inventory route**

Create `WEBAPP/app/api/admin/models/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

// Model inventory (admin). The inventory itself is proxy-wide, but requests are
// still routed through an agent's service because that is how the gateway
// addresses the proxy at all.
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const agent = req.nextUrl.searchParams.get("agent");
  if (!agent || !isInstance(agent)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, "/models", { method: "GET" });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  if (!agent || !isInstance(agent) || typeof body?.model_name !== "string" || !body.model_name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { agent: _agent, ...payload } = body;
  return proxyAdminJsonAgent(session, agent, "/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function PUT(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  const name = req.nextUrl.searchParams.get("name");
  if (!agent || !isInstance(agent) || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { agent: _agent, name: _name, ...payload } = body;
  return proxyAdminJsonAgent(session, agent, `/models/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const p = req.nextUrl.searchParams;
  const agent = p.get("agent");
  const name = p.get("name");
  if (!agent || !isInstance(agent) || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, `/models/${encodeURIComponent(name)}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Write the status, deprecate, order and usage routes**

Create `WEBAPP/app/api/admin/models/status/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

export async function PUT(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  const name = req.nextUrl.searchParams.get("name");
  const status = body?.status;
  if (!agent || !isInstance(agent) || !name || !["active", "disabled"].includes(status)) {
    // "deprecated" is not settable here: retiring a model needs a replacement and
    // goes through /models/deprecate.
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, `/models/${encodeURIComponent(name)}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, version: body.version }),
  });
}
```

Create `WEBAPP/app/api/admin/models/deprecate/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  const name = typeof body?.name === "string" ? body.name : null;
  const replacedBy = typeof body?.replaced_by === "string" ? body.replaced_by : null;
  if (!agent || !isInstance(agent) || !name || !replacedBy) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, `/models/${encodeURIComponent(name)}/deprecate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replaced_by: replacedBy, version: body.version }),
  });
}
```

Create `WEBAPP/app/api/admin/models/order/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

export async function PUT(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  if (!agent || !isInstance(agent) || !Array.isArray(body?.order)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, "/models/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: body.order }),
  });
}
```

Create `WEBAPP/app/api/admin/models/usage/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const p = req.nextUrl.searchParams;
  const agent = p.get("agent");
  const name = p.get("name");
  if (!agent || !isInstance(agent) || !name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, `/models/${encodeURIComponent(name)}/usage`, { method: "GET" });
}
```

- [ ] **Step 3: Write the catalog, defaults and assignments routes**

Create `WEBAPP/app/api/admin/model-catalog/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const agent = req.nextUrl.searchParams.get("agent");
  if (!agent || !isInstance(agent)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, "/model-catalog", { method: "GET" });
}
```

Create `WEBAPP/app/api/admin/model-defaults/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

const SCOPES = ["global", "agent", "tenant", "subscription"];

// upstreamQuery forwards only the scope identifiers. The proxy decides the gate
// from them, so the BFF must not add or reinterpret any.
function upstreamQuery(req: NextRequest): string | null {
  const p = req.nextUrl.searchParams;
  const scope = p.get("scope");
  if (!scope || !SCOPES.includes(scope)) return null;
  const out = new URLSearchParams({ scope });
  if (scope === "tenant" || scope === "subscription") {
    const tenantId = p.get("tenant_id");
    if (!tenantId) return null;
    out.set("tenant_id", tenantId);
  }
  if (scope === "subscription") {
    const subsAccId = p.get("subs_acc_id");
    if (!subsAccId) return null;
    out.set("subs_acc_id", subsAccId);
  }
  return out.toString();
}

async function forward(req: NextRequest, method: "GET" | "PUT" | "DELETE") {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const agent = req.nextUrl.searchParams.get("agent");
  const query = upstreamQuery(req);
  if (!agent || !isInstance(agent) || !query) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (method !== "PUT") {
    return proxyAdminJsonAgent(session, agent, `/model-defaults?${query}`, { method });
  }
  const body = await req.json().catch(() => null);
  if (typeof body?.model_name !== "string" || !body.model_name) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return proxyAdminJsonAgent(session, agent, `/model-defaults?${query}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: body.model_name }),
  });
}

export const GET = (req: NextRequest) => forward(req, "GET");
export const PUT = (req: NextRequest) => forward(req, "PUT");
export const DELETE = (req: NextRequest) => forward(req, "DELETE");
```

Create `WEBAPP/app/api/admin/model-assignments/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { proxyAdminJsonAgent, requireSession } from "@/lib/adminProxy";
import { isInstance } from "@/lib/mycelium";

async function forward(req: NextRequest, method: "POST" | "DELETE") {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => null);
  const agent = typeof body?.agent === "string" ? body.agent : null;
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id : null;
  const subsAccId = typeof body?.subs_acc_id === "string" ? body.subs_acc_id : null;
  const userAccId = typeof body?.user_acc_id === "string" ? body.user_acc_id : null;
  if (!agent || !isInstance(agent) || !tenantId || !subsAccId || !userAccId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    subs_acc_id: subsAccId,
    user_acc_id: userAccId,
  };
  if (method === "POST") {
    if (typeof body?.model_name !== "string" || !body.model_name) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    payload.model_name = body.model_name;
  }
  return proxyAdminJsonAgent(session, agent, "/model-assignments", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export const POST = (req: NextRequest) => forward(req, "POST");
export const DELETE = (req: NextRequest) => forward(req, "DELETE");
```

- [ ] **Step 4: Delete the superseded routes**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git rm -r app/api/admin/registered-models
```

- [ ] **Step 5: Type-check**

Run: `cd WEBAPP && yarn tsc --noEmit 2>&1 | head -20`
Expected: errors only in `app/admin/model-registry-panel.tsx` (T19 rewrites it). No errors in `app/api/admin/`.

- [ ] **Step 6: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git add app/api/admin/
git commit -m "feat(api): BFF routes for the model inventory

Each route validates shape only and forwards; the proxy owns every authorization
decision, so the BFF never adds or reinterprets a scope identifier. The status
route refuses 'deprecated' on purpose — retiring a model needs a replacement and
goes through /models/deprecate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 19: the inventory panel — two lists, register/edit form, duplicate

**Files:**
- Rewrite: `WEBAPP/app/admin/model-registry-panel.tsx`
- Create: `WEBAPP/app/admin/model-row.tsx`
- Create: `WEBAPP/app/admin/model-row.test.tsx`

**Interfaces:**
- Consumes: T17 `lib/models.ts`, T18 routes; existing `Button`, `IconButton`, `Input`, `Badge`, `Alert`, `Spinner` from `components/ui/`.
- Produces:
  - `ModelRow` — a presentational component taking `{ model, onEdit, onDuplicate, onToggle, onDeprecate, onDelete, busy }`
  - `ModelRegistryPanel` — default export, same props as today (`{ scope, agents, target }`)

- [ ] **Step 1: Write the failing test**

Create `WEBAPP/app/admin/model-row.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { ModelRow } from "./model-row";
import type { InventoryModel } from "@/lib/models";

function model(over: Partial<InventoryModel> = {}): InventoryModel {
  return {
    model_name: "gpt-5.4",
    provider: "openai",
    model: "gpt-5.4",
    api_base: "https://api.openai.com/v1",
    status: "active",
    fallbacks: [],
    position: 1,
    has_key: true,
    in_use_count: 0,
    version: 1,
    created_at: "2026-07-25T12:00:00Z",
    updated_at: "2026-07-25T12:00:00Z",
    ...over,
  };
}

const noop = () => {};
const handlers = { onEdit: noop, onDuplicate: noop, onToggle: noop, onDeprecate: noop, onDelete: noop };

describe("ModelRow", () => {
  it("shows the name, provider, api_base and a key badge", () => {
    const html = renderToStaticMarkup(<ModelRow model={model()} busy={false} {...handlers} />);
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("openai");
    expect(html).toContain("https://api.openai.com/v1");
    expect(html).toContain("key");
  });

  it("shows the declared fallback chain, because the chain decides which keys land in a workspace", () => {
    const html = renderToStaticMarkup(
      <ModelRow model={model({ fallbacks: ["backup", "last-resort"] })} busy={false} {...handlers} />,
    );
    expect(html).toContain("backup");
    expect(html).toContain("last-resort");
  });

  it("disables delete and disable while the model is in use, and says why", () => {
    const html = renderToStaticMarkup(
      <ModelRow model={model({ in_use_count: 3 })} busy={false} {...handlers} />,
    );
    // Two disabled buttons (delete + disable) and a reason the admin can act on.
    expect(html).toContain("disabled");
    expect(html).toContain("in use by 3");
  });

  it("enables delete when nothing uses the model", () => {
    const html = renderToStaticMarkup(<ModelRow model={model({ in_use_count: 0 })} busy={false} {...handlers} />);
    expect(html).not.toContain("in use by");
  });

  it("badges a deprecated model with its replacement", () => {
    const html = renderToStaticMarkup(
      <ModelRow model={model({ status: "deprecated", replaced_by: "gpt-6" })} busy={false} {...handlers} />,
    );
    expect(html).toContain("replaced by gpt-6");
  });

  it("badges an imported orphan so the admin reviews it", () => {
    const html = renderToStaticMarkup(
      <ModelRow model={model({ imported_orphan: true })} busy={false} {...handlers} />,
    );
    expect(html).toContain("imported");
  });

  it("renders as an <li> so the caller's <ul> stays valid markup", () => {
    const html = renderToStaticMarkup(<ModelRow model={model()} busy={false} {...handlers} />);
    expect(html.startsWith("<li")).toBe(true);
  });

  it("shows reorder arrows only when a move handler is supplied", () => {
    const without = renderToStaticMarkup(<ModelRow model={model()} busy={false} {...handlers} />);
    expect(without).not.toContain("Move gpt-5.4 up");

    const withMove = renderToStaticMarkup(
      <ModelRow model={model()} busy={false} {...handlers} onMoveUp={noop} onMoveDown={noop} />,
    );
    expect(withMove).toContain("Move gpt-5.4 up");
    expect(withMove).toContain("Move gpt-5.4 down");
  });

  it("disables the up arrow at the top of the list", () => {
    // onMoveUp absent means "already first" — the arrow renders but cannot fire, so
    // the row does not need to know its own index.
    const html = renderToStaticMarkup(
      <ModelRow model={model()} busy={false} {...handlers} onMoveDown={noop} />,
    );
    expect(html).toContain("Move gpt-5.4 up");
    expect(html).toMatch(/aria-label="Move gpt-5\.4 up"[^>]*disabled/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd WEBAPP && yarn vitest run app/admin/model-row.test.tsx`
Expected: FAIL — cannot resolve `./model-row`.

- [ ] **Step 3: Write the row component**

Create `WEBAPP/app/admin/model-row.tsx`:

```tsx
"use client";

import { cva } from "class-variance-authority";
import { Pencil, Copy, PowerOff, Power, Archive, Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import { inactiveReason, type InventoryModel } from "@/lib/models";

// Variants rather than interpolated className strings, per the codebase's
// convention.
const row = cva(
  "flex items-center gap-2 rounded-lg border px-3 py-1.5",
  {
    variants: {
      state: {
        active: "border-brand/30 bg-elevated",
        inactive: "border-brand/20 bg-elevated/60 opacity-80",
      },
    },
    defaultVariants: { state: "active" },
  },
);

export function ModelRow({
  model,
  busy,
  onEdit,
  onDuplicate,
  onToggle,
  onDeprecate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  model: InventoryModel;
  busy: boolean;
  onEdit: (m: InventoryModel) => void;
  onDuplicate: (m: InventoryModel) => void;
  onToggle: (m: InventoryModel) => void;
  onDeprecate: (m: InventoryModel) => void;
  onDelete: (m: InventoryModel) => void;
  // Reorder arrows live INSIDE the row so the list stays <ul><li>: wrapping the
  // row in a positioning <div> would put a non-li child in the <ul> and nest the
  // <li> inside it, which is invalid markup. Absent means not reorderable.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const inUse = model.in_use_count > 0;
  // Delete and disable share one precondition — nothing may reference the model.
  // Deprecation is the tool for retiring something in use, so it stays available.
  const lockReason = inUse ? `in use by ${model.in_use_count}` : "";
  const reason = inactiveReason(model);

  return (
    <li className={row({ state: model.status === "active" ? "active" : "inactive" })}>
      {(onMoveUp || onMoveDown) && (
        <div className="flex shrink-0 flex-col">
          <button type="button" aria-label={`Move ${model.model_name} up`} className="text-xs text-fg-muted"
            disabled={busy || !onMoveUp} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" aria-label={`Move ${model.model_name} down`} className="text-xs text-fg-muted"
            disabled={busy || !onMoveDown} onClick={onMoveDown}>
            ↓
          </button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs text-fg">{model.model_name}</span>
        <span className="truncate text-[11px] text-fg-muted">
          {model.provider}
          {model.api_base ? ` · ${model.api_base}` : ""}
        </span>
        {model.fallbacks.length > 0 && (
          <span className="truncate text-[11px] text-fg-muted">
            fallbacks: {model.fallbacks.join(" → ")}
          </span>
        )}
      </div>

      {reason && <Badge tone="neutral">{reason}</Badge>}
      {model.imported_orphan && <Badge tone="neutral">imported</Badge>}
      {model.has_key && <Badge tone="neutral">key</Badge>}
      {inUse && <Badge tone="accent">{lockReason}</Badge>}

      <IconButton variant="ghost" size="sm" aria-label={`Edit ${model.model_name}`} title="Edit"
        disabled={busy} onClick={() => onEdit(model)}>
        <Pencil size={15} aria-hidden />
      </IconButton>
      <IconButton variant="ghost" size="sm" aria-label={`Duplicate ${model.model_name}`} title="Duplicate"
        disabled={busy} onClick={() => onDuplicate(model)}>
        <Copy size={15} aria-hidden />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label={`${model.status === "active" ? "Disable" : "Enable"} ${model.model_name}`}
        title={inUse && model.status === "active" ? `Cannot disable: ${lockReason}` : "Enable / disable"}
        disabled={busy || (inUse && model.status === "active")}
        onClick={() => onToggle(model)}
      >
        {model.status === "active" ? <PowerOff size={15} aria-hidden /> : <Power size={15} aria-hidden />}
      </IconButton>
      {model.status === "active" && (
        <IconButton variant="ghost" size="sm" aria-label={`Deprecate ${model.model_name}`}
          title="Deprecate (retire while keeping existing users on it)"
          disabled={busy} onClick={() => onDeprecate(model)}>
          <Archive size={15} aria-hidden />
        </IconButton>
      )}
      <IconButton
        variant="ghost"
        size="sm"
        aria-label={`Delete ${model.model_name}`}
        title={inUse ? `Cannot delete: ${lockReason}` : "Delete"}
        disabled={busy || inUse}
        onClick={() => onDelete(model)}
      >
        <Trash2 size={15} aria-hidden />
      </IconButton>
    </li>
  );
}
```

- [ ] **Step 4: Run the row tests**

Run: `cd WEBAPP && yarn vitest run app/admin/model-row.test.tsx`
Expected: PASS — all six.

- [ ] **Step 5: Rewrite the panel's inventory half**

Replace `WEBAPP/app/admin/model-registry-panel.tsx` with the inventory region. Keep the existing default export name and props so `app/admin/`'s tab wiring is untouched.

```tsx
"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  listModels,
  modelCatalog,
  createModel,
  updateModel,
  deleteModel,
  setModelStatus,
  deprecateModel,
  reorderModels,
  splitInventory,
  draftFromCatalog,
  draftFromDuplicate,
  emptyDraft,
  type CatalogEntry,
  type InventoryModel,
  type ModelDraft,
} from "@/lib/models";
import { ALL_AGENTS, type ScopeRef } from "@/lib/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ModelRow } from "./model-row";

const selectClass =
  "h-11 w-full rounded-lg border border-brand bg-elevated px-3 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

const CUSTOM = "__custom__";

// Admin model inventory. The inventory is PROXY-WIDE — not per agent — so the
// agent picker only decides which service the request is routed through, and
// ALL_AGENTS resolves to the first agent rather than fanning out.
export default function ModelRegistryPanel({
  scope,
  agents,
  target,
}: {
  scope: ScopeRef;
  agents: string[];
  target: string;
}) {
  const routed = target === ALL_AGENTS ? agents[0] ?? "" : target;

  const [models, setModels] = useState<InventoryModel[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(emptyDraft());
  // editing holds the model_name + version being edited; null means "create".
  const [editing, setEditing] = useState<{ name: string; version: number } | null>(null);
  // deprecating holds the model being retired while the admin picks its
  // replacement. An inline picker rather than window.prompt: the replacement must
  // be an existing ACTIVE model, and a free-text prompt cannot offer that list —
  // the admin would type a name and get a 400 with no way to see the valid ones.
  const [deprecating, setDeprecating] = useState<InventoryModel | null>(null);
  const [replacement, setReplacement] = useState("");

  const refresh = useCallback(async () => {
    if (!routed) return;
    setModels(await listModels(routed));
  }, [routed]);

  useEffect(() => {
    if (!routed) return;
    let cancelled = false;
    setModels(null);
    setError(null);
    listModels(routed)
      .then((m) => !cancelled && setModels(m))
      .catch((e: Error) => !cancelled && setError(e.message));
    modelCatalog(routed)
      .then((c) => !cancelled && setCatalog(c))
      .catch(() => !cancelled && setCatalog([]));
    return () => {
      cancelled = true;
    };
  }, [routed]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setDraft(emptyDraft());
    setEditing(null);
    setShowForm(true);
  }

  function openEdit(m: InventoryModel) {
    // api_key stays blank: the API never returns it, and leaving it blank means
    // saving keeps the stored key rather than clearing it.
    setDraft({
      model_name: m.model_name,
      provider: m.provider,
      model: m.model,
      api_base: m.api_base ?? "",
      auth_method: m.auth_method ?? "",
      api_key: "",
      fallbacks: [...m.fallbacks],
    });
    setEditing({ name: m.model_name, version: m.version });
    setShowForm(true);
  }

  function openDuplicate(m: InventoryModel) {
    setDraft(draftFromDuplicate(m));
    setEditing(null);
    setShowForm(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.model_name.trim() || !draft.provider.trim() || !draft.model.trim()) {
      setError("Fill model name, provider and model.");
      return;
    }
    await run(async () => {
      if (editing) {
        await updateModel(routed, editing.name, editing.version, draft);
      } else {
        await createModel(routed, draft);
      }
      setShowForm(false);
      setDraft(emptyDraft());
      setEditing(null);
      await refresh();
    });
  }

  function onCatalogPick(value: string) {
    if (value === CUSTOM) {
      setDraft((d) => ({ ...d, provider: "", model: "", api_base: "", auth_method: "" }));
      return;
    }
    const entry = catalog[Number(value)];
    if (!entry) return;
    // Keep whatever name and key the admin already typed; only the definition
    // fields are prefilled.
    setDraft((d) => ({ ...draftFromCatalog(entry), model_name: d.model_name, api_key: d.api_key, fallbacks: d.fallbacks }));
  }

  const { active, inactive } = splitInventory(models ?? []);

  function move(list: InventoryModel[], index: number, delta: number) {
    const next = [...list];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    // Send BOTH groups: SetPositions renumbers 1..N over exactly the names it
    // receives, so sending only the active ones would leave inactive models holding
    // stale positions that collide with active ones — and a reactivated model would
    // no longer land back in its old place.
    const order = [...next, ...inactive].map((m) => m.model_name);
    void run(async () => {
      await reorderModels(routed, order);
      await refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {error && <Alert severity="error">{error}</Alert>}

      {!routed && (
        <Alert severity="info">No agents reported by the gateway, so the inventory cannot be reached.</Alert>
      )}

      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 bg-accent" aria-hidden />
        <span className="flex-1 font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Model inventory
        </span>
        <Button variant="text" size="sm" className="gap-1.5 px-1 text-accent" disabled={!routed} onClick={openCreate}>
          <Plus size={16} />
          Register model
        </Button>
      </div>

      {showForm && (
        <form onSubmit={onSubmit} className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-elevated p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-muted">Start from a known model</span>
            <select className={selectClass} defaultValue="" onChange={(e) => onCatalogPick(e.target.value)}>
              <option value="" disabled>
                pick one to prefill…
              </option>
              {catalog.map((c, i) => (
                <option key={`${c.provider}|${c.model}`} value={String(i)}>
                  {c.provider} · {c.model}
                </option>
              ))}
              <option value={CUSTOM}>custom (fill everything by hand)</option>
            </select>
          </label>
          <Input inputSize="sm" placeholder="model name (unique, e.g. team-gpt)" value={draft.model_name}
            disabled={!!editing}
            onChange={(e) => setDraft({ ...draft, model_name: e.target.value })} />
          <Input inputSize="sm" placeholder="provider (e.g. openai)" value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })} />
          <Input inputSize="sm" placeholder="model (e.g. gpt-5.4)" value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <Input inputSize="sm" placeholder="api_base" value={draft.api_base}
            onChange={(e) => setDraft({ ...draft, api_base: e.target.value })} />
          <Input inputSize="sm" placeholder="auth_method (optional, e.g. oauth)" value={draft.auth_method}
            onChange={(e) => setDraft({ ...draft, auth_method: e.target.value })} />
          <Input inputSize="sm" type="password" autoComplete="off"
            placeholder={editing ? "api_key (leave blank to keep the stored key)" : "api_key (write-only)"}
            value={draft.api_key}
            onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="text" size="sm"
              onClick={() => { setShowForm(false); setDraft(emptyDraft()); setEditing(null); }}>
              Cancel
            </Button>
            <Button type="submit" variant="filled" size="sm" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save" : "Register"}
            </Button>
          </div>
        </form>
      )}

      {models === null && !error ? (
        <div className="flex justify-center py-3">
          <Spinner size={18} />
        </div>
      ) : (
        <>
          <Section title="Active">
            {active.length === 0 ? (
              <p className="py-2 text-sm text-fg-muted">No active models. Register one to get started.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {active.map((m, i) => (
                  <ModelRow key={m.model_name} model={m} busy={busy}
                    onMoveUp={i === 0 ? undefined : () => move(active, i, -1)}
                    onMoveDown={i === active.length - 1 ? undefined : () => move(active, i, 1)}
                    onEdit={openEdit} onDuplicate={openDuplicate}
                    onToggle={(mm) => run(async () => {
                      await setModelStatus(routed, mm.model_name, mm.version, "disabled");
                      await refresh();
                    })}
                    onDeprecate={setDeprecating}
                    onDelete={(mm) => run(async () => {
                      await deleteModel(routed, mm.model_name);
                      await refresh();
                    })} />
                ))}
              </ul>
            )}
            <p className="text-[11px] text-fg-muted">
              This order is for reading only. A model&apos;s fallback chain is the{" "}
              <span className="font-mono">fallbacks</span> list on the model itself.
            </p>

            {deprecating && (
              <div className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-elevated p-3">
                <span className="text-xs font-medium text-fg-muted">
                  Retire <span className="font-mono">{deprecating.model_name}</span>
                </span>
                <p className="text-[11px] text-fg-muted">
                  Everyone already using it keeps it. New users get the replacement instead.
                </p>
                <select className={selectClass} value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}>
                  <option value="" disabled>
                    replacement for new users…
                  </option>
                  {active
                    .filter((m) => m.model_name !== deprecating.model_name)
                    .map((m) => (
                      <option key={m.model_name} value={m.model_name}>
                        {m.model_name}
                      </option>
                    ))}
                </select>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="text" size="sm"
                    onClick={() => { setDeprecating(null); setReplacement(""); }}>
                    Cancel
                  </Button>
                  <Button variant="filled" size="sm" disabled={busy || !replacement}
                    onClick={() =>
                      run(async () => {
                        await deprecateModel(routed, deprecating.model_name, deprecating.version, replacement);
                        setDeprecating(null);
                        setReplacement("");
                        await refresh();
                      })
                    }>
                    Deprecate
                  </Button>
                </div>
              </div>
            )}
          </Section>

          <Section title="Inactive">
            {inactive.length === 0 ? (
              <p className="py-2 text-sm text-fg-muted">Nothing disabled or deprecated.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {inactive.map((m) => (
                  <ModelRow key={m.model_name} model={m} busy={busy}
                    onEdit={openEdit} onDuplicate={openDuplicate}
                    onToggle={(mm) => run(async () => {
                      await setModelStatus(routed, mm.model_name, mm.version, "active");
                      await refresh();
                    })}
                    onDeprecate={() => {}}
                    onDelete={(mm) => run(async () => {
                      await deleteModel(routed, mm.model_name);
                      await refresh();
                    })} />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 6: Type-check and build**

Run: `cd WEBAPP && yarn tsc --noEmit && yarn next build 2>&1 | tail -20`
Expected: both clean. If `ScopeRef` is unused in this file now, remove it from the props type only if the tab wiring does not pass it — otherwise keep the prop and prefix it `_scope`.

- [ ] **Step 7: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git add app/admin/model-registry-panel.tsx app/admin/model-row.tsx app/admin/model-row.test.tsx
git commit -m "feat(admin): inventory panel — active/inactive lists, catalog-driven form, duplicate

The register form is driven by the embedded suggestion catalog instead of five
free-text inputs, which is what makes typo-driven failures impossible rather than
merely unlikely. Duplicate blanks the name and the key: the name must be unique
and the key is never returned by the API.

The active list is reorderable but the copy says plainly that the order is for
reading only — a model's chain is its own fallbacks list. Delete and disable are
rendered unavailable with the reason while a model is in use; deprecate stays
available, since that is the tool for retiring something in use.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 20: defaults, per-user assignment, fallback chain editor

**Files:**
- Create: `WEBAPP/app/admin/model-defaults-panel.tsx`
- Create: `WEBAPP/app/admin/fallback-editor.tsx`
- Create: `WEBAPP/app/admin/fallback-editor.test.tsx`
- Modify: `WEBAPP/app/admin/model-registry-panel.tsx` (render both)

**Interfaces:**
- Consumes: T17, T19.
- Produces:
  - `FallbackEditor` — `{ model, all, busy, onSave }`
  - `ModelDefaultsPanel` — `{ scope, routed, models }`
  - `fallbackCandidates(all, self) => InventoryModel[]`

- [ ] **Step 1: Write the failing test**

Create `WEBAPP/app/admin/fallback-editor.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { FallbackEditor, fallbackCandidates } from "./fallback-editor";
import type { InventoryModel } from "@/lib/models";

function model(name: string, over: Partial<InventoryModel> = {}): InventoryModel {
  return {
    model_name: name,
    provider: "openai",
    model: name,
    api_base: "https://x/v1",
    status: "active",
    fallbacks: [],
    position: 1,
    has_key: true,
    in_use_count: 0,
    version: 1,
    created_at: "2026-07-25T12:00:00Z",
    updated_at: "2026-07-25T12:00:00Z",
    ...over,
  };
}

describe("fallbackCandidates", () => {
  it("excludes the model itself", () => {
    const all = [model("a"), model("b")];
    expect(fallbackCandidates(all, "a").map((m) => m.model_name)).toEqual(["b"]);
  });

  it("excludes non-active models, which the resolver would skip anyway", () => {
    const all = [model("a"), model("off", { status: "disabled" }), model("old", { status: "deprecated" })];
    expect(fallbackCandidates(all, "a").map((m) => m.model_name)).toEqual([]);
  });
});

describe("FallbackEditor", () => {
  it("lists the current chain in order", () => {
    const html = renderToStaticMarkup(
      <FallbackEditor
        model={model("main", { fallbacks: ["first", "second"] })}
        all={[model("main"), model("first"), model("second")]}
        busy={false}
        onSave={() => {}}
      />,
    );
    const firstAt = html.indexOf("first");
    const secondAt = html.indexOf("second");
    expect(firstAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it("states that this list is what becomes model_fallbacks", () => {
    const html = renderToStaticMarkup(
      <FallbackEditor model={model("main")} all={[model("main")]} busy={false} onSave={() => {}} />,
    );
    expect(html).toContain("model_fallbacks");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd WEBAPP && yarn vitest run app/admin/fallback-editor.test.tsx`
Expected: FAIL — cannot resolve `./fallback-editor`.

- [ ] **Step 3: Write the fallback editor**

Create `WEBAPP/app/admin/fallback-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { InventoryModel } from "@/lib/models";

const selectClass =
  "h-9 w-full rounded-lg border border-brand bg-elevated px-2 text-xs text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

// fallbackCandidates excludes the model itself and every non-active model: the
// resolver skips a non-active fallback anyway, so offering one would let an admin
// build a chain that silently does nothing.
export function fallbackCandidates(all: InventoryModel[], self: string): InventoryModel[] {
  return all.filter((m) => m.model_name !== self && m.status === "active");
}

export function FallbackEditor({
  model,
  all,
  busy,
  onSave,
}: {
  model: InventoryModel;
  all: InventoryModel[];
  busy: boolean;
  onSave: (chain: string[]) => void;
}) {
  const [chain, setChain] = useState<string[]>([...model.fallbacks]);
  const candidates = fallbackCandidates(all, model.model_name).filter((m) => !chain.includes(m.model_name));

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    [next[index], next[to]] = [next[to], next[index]];
    setChain(next);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-elevated p-3">
      <span className="text-xs font-medium text-fg-muted">
        Fallback chain for <span className="font-mono">{model.model_name}</span>
      </span>
      <p className="text-[11px] text-fg-muted">
        This ordered list — not the inventory listing order — becomes{" "}
        <span className="font-mono">agents.defaults.model_fallbacks</span>. Every model here also gets its key
        written into each workspace that uses <span className="font-mono">{model.model_name}</span>.
      </p>

      {chain.length === 0 ? (
        <p className="text-sm text-fg-muted">No fallbacks. Requests that fail have nowhere to go.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {chain.map((name, i) => (
            <li key={name} className="flex items-center gap-2 rounded-lg border border-brand/20 px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                {i + 1}. {name}
              </span>
              <button type="button" aria-label={`Move ${name} up`} className="text-xs text-fg-muted"
                disabled={busy || i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" aria-label={`Move ${name} down`} className="text-xs text-fg-muted"
                disabled={busy || i === chain.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <IconButton variant="ghost" size="sm" aria-label={`Remove ${name}`} title="Remove"
                disabled={busy} onClick={() => setChain(chain.filter((n) => n !== name))}>
                <X size={14} aria-hidden />
              </IconButton>
            </li>
          ))}
        </ol>
      )}

      <select className={selectClass} value="" disabled={busy || candidates.length === 0}
        onChange={(e) => e.target.value && setChain([...chain, e.target.value])}>
        <option value="" disabled>
          {candidates.length === 0 ? "no other active models" : "add a fallback…"}
        </option>
        {candidates.map((m) => (
          <option key={m.model_name} value={m.model_name}>
            {m.model_name}
          </option>
        ))}
      </select>

      <div className="flex justify-end">
        <Button variant="tonal" size="sm" disabled={busy} onClick={() => onSave(chain)}>
          Save chain
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the defaults and assignment panel**

Create `WEBAPP/app/admin/model-defaults-panel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getModelDefault,
  setModelDefault,
  clearModelDefault,
  setModelAssignment,
  clearModelAssignment,
  type DefaultScope,
  type InventoryModel,
  type ScopeDefault,
} from "@/lib/models";
import { listSubscriptionUsers, type ScopeRef, type UserRef } from "@/lib/admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

const selectClass = "h-9 rounded-lg border border-brand bg-surface px-2 text-xs text-fg";

// Scope defaults plus per-user pins. A pin wins over every default (the proxy's
// cascade is user > subscription > tenant > agent > global), so the UI has to make
// the difference between a pin and a cascade visible.
export default function ModelDefaultsPanel({
  scope,
  routed,
  models,
}: {
  scope: ScopeRef;
  routed: string;
  models: InventoryModel[];
}) {
  const [current, setCurrent] = useState<ScopeDefault | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const assignable = models.filter((m) => m.status !== "disabled");

  // Which cascade level the default control addresses. global and agent are
  // instance-wide (the proxy gates them at proxy-admin); tenant and subscription
  // follow the scope tree on the left. Without this selector there is no way to set
  // an instance-wide default at all, and a fresh install with no scope default
  // refuses to provision every new workspace.
  const [level, setLevel] = useState<DefaultScope["kind"]>(
    scope.kind === "subscription" ? "subscription" : "tenant",
  );

  const defaultScope: DefaultScope | null =
    level === "global"
      ? { kind: "global" }
      : level === "agent"
        ? { kind: "agent" }
        : level === "subscription" && scope.kind === "subscription" && scope.subsAccId
          ? { kind: "subscription", tenantId: scope.tenantId, subsAccId: scope.subsAccId }
          : level === "tenant" && scope.tenantId
            ? { kind: "tenant", tenantId: scope.tenantId }
            : null;

  // One serialized dependency instead of picking fields off a union: the scope's
  // identity IS its serialization, and casting to read optional fields would be a
  // silent hazard the next time the union grows a member.
  const scopeKey = defaultScope ? JSON.stringify(defaultScope) : "";

  const load = useCallback(async () => {
    if (!routed || !scopeKey) {
      setLoaded(true);
      return;
    }
    setCurrent(await getModelDefault(routed, JSON.parse(scopeKey) as DefaultScope));
    setLoaded(true);
  }, [routed, scopeKey]);

  useEffect(() => {
    setLoaded(false);
    load().catch((e: Error) => {
      setError(e.message);
      setLoaded(true);
    });
  }, [load]);

  useEffect(() => {
    if (scope.kind !== "subscription" || !scope.subsAccId) {
      setUsers(null);
      return;
    }
    let cancelled = false;
    setUsers(null);
    listSubscriptionUsers(scope.tenantId, scope.subsAccId)
      .then((u) => !cancelled && setUsers(u))
      .catch(() => !cancelled && setUsers([]));
    return () => {
      cancelled = true;
    };
  }, [scope.kind, scope.tenantId, scope.subsAccId]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error && <Alert severity="error">{error}</Alert>}

      <div className="flex flex-col gap-2">
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Default model
        </span>
        <label className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">Level</span>
          <select className={selectClass} value={level} disabled={busy}
            onChange={(e) => setLevel(e.target.value as DefaultScope["kind"])}>
            <option value="global">global (whole instance)</option>
            <option value="agent">agent (this agent, all tenants)</option>
            <option value="tenant">tenant</option>
            <option value="subscription">subscription</option>
          </select>
        </label>
        <p className="text-[11px] text-fg-muted">
          Resolution order, most specific first: per-user pin → subscription → tenant → agent → global.
        </p>
        {!defaultScope ? (
          <p className="py-2 text-sm text-fg-muted">
            Select a {level} on the left to set its default.
          </p>
        ) : !loaded ? (
          <div className="flex justify-center py-3">
            <Spinner size={18} />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select className={selectClass} value={current?.model_name ?? ""} disabled={busy}
              onChange={(e) =>
                run(async () => {
                  await setModelDefault(routed, defaultScope, e.target.value);
                  await load();
                })
              }>
              <option value="" disabled>
                no default set
              </option>
              {models.filter((m) => m.status === "active").map((m) => (
                <option key={m.model_name} value={m.model_name}>
                  {m.model_name}
                </option>
              ))}
            </select>
            {current && (
              <Button variant="text" size="sm" disabled={busy}
                onClick={() =>
                  run(async () => {
                    await clearModelDefault(routed, defaultScope);
                    await load();
                  })
                }>
                Clear
              </Button>
            )}
          </div>
        )}
        <p className="text-[11px] text-fg-muted">
          New workspaces at this level land on this model unless a more specific level or a per-user
          pin overrides it. Setting a <span className="font-mono">global</span> or{" "}
          <span className="font-mono">agent</span> default requires instance-admin privileges, and takes
          effect on each workspace&apos;s next start rather than restarting the fleet.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-display text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Per-user pins
        </span>
        {scope.kind !== "subscription" ? (
          <p className="py-2 text-sm text-fg-muted">Select a subscription to pin models to its users.</p>
        ) : users === null ? (
          <div className="flex justify-center py-3">
            <Spinner size={18} />
          </div>
        ) : users.length === 0 ? (
          <p className="py-2 text-sm text-fg-muted">
            No users have a workspace under this subscription yet (they must start a chat first).
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {users.map((u) => (
              <li key={`${u.role}|${u.accId}`}
                className="flex items-center gap-2 rounded-lg border border-brand/30 bg-elevated px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-fg" title={u.accId}>
                  {u.name || u.email || u.accId}
                </span>
                {u.role && <Badge tone="accent">{u.role}</Badge>}
                <select className={selectClass} value={pick[u.accId] ?? ""} disabled={busy}
                  onChange={(e) => setPick((prev) => ({ ...prev, [u.accId]: e.target.value }))}>
                  <option value="" disabled>
                    inherited from scope
                  </option>
                  {assignable.map((m) => (
                    <option key={m.model_name} value={m.model_name}>
                      {m.model_name}
                    </option>
                  ))}
                </select>
                <Button variant="tonal" size="sm" disabled={busy || !pick[u.accId]}
                  onClick={() =>
                    run(async () => {
                      await setModelAssignment(
                        u.role ?? routed,
                        { tenantId: scope.tenantId, subsAccId: scope.subsAccId!, userAccId: u.accId },
                        pick[u.accId],
                      );
                    })
                  }>
                  Pin
                </Button>
                <Button variant="text" size="sm" disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await clearModelAssignment(u.role ?? routed, {
                        tenantId: scope.tenantId,
                        subsAccId: scope.subsAccId!,
                        userAccId: u.accId,
                      });
                      setPick((prev) => ({ ...prev, [u.accId]: "" }));
                    })
                  }>
                  Unpin
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render both from the inventory panel**

In `WEBAPP/app/admin/model-registry-panel.tsx`:

Add the imports:

```tsx
import ModelDefaultsPanel from "./model-defaults-panel";
import { FallbackEditor } from "./fallback-editor";
```

Add the state that tracks which model's chain is open:

```tsx
  const [chainFor, setChainFor] = useState<InventoryModel | null>(null);
```

In the active list, close the chain editor when the admin switches to the edit form —
two panels open on different models at once is how someone saves a chain onto the
wrong model:

```tsx
                    onEdit={(mm) => { setChainFor(null); openEdit(mm); }}
```

and render the chain editor plus the defaults panel just before the closing `</div>` of the component:

```tsx
      {chainFor && (
        <FallbackEditor
          model={chainFor}
          all={models ?? []}
          busy={busy}
          onSave={(chain) =>
            run(async () => {
              await updateModel(routed, chainFor.model_name, chainFor.version, {
                model_name: chainFor.model_name,
                provider: chainFor.provider,
                model: chainFor.model,
                api_base: chainFor.api_base ?? "",
                auth_method: chainFor.auth_method ?? "",
                api_key: "",
                fallbacks: chain,
              });
              setChainFor(null);
              await refresh();
            })
          }
        />
      )}

      {routed && <ModelDefaultsPanel scope={scope} routed={routed} models={models ?? []} />}
```

Add a chain button to the active rows by giving `ModelRow` one more optional prop. In `model-row.tsx` add to the props type:

```tsx
  onEditChain?: (m: InventoryModel) => void;
```

and render, before the delete button:

```tsx
      {onEditChain && (
        <IconButton variant="ghost" size="sm" aria-label={`Edit fallback chain for ${model.model_name}`}
          title="Fallback chain" disabled={busy} onClick={() => onEditChain(model)}>
          <span aria-hidden className="text-xs">⛓</span>
        </IconButton>
      )}
```

Pass `onEditChain={setChainFor}` on the active-list rows only — an inactive model is not materialized anywhere, so editing its chain has no effect worth offering.

- [ ] **Step 6: Run the tests, type-check and build**

Run: `cd WEBAPP && yarn vitest run && yarn tsc --noEmit && yarn next build 2>&1 | tail -20`
Expected: all vitest green (including the pre-existing 55), `tsc` clean, build clean.

- [ ] **Step 7: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git add app/admin/
git commit -m "feat(admin): scope defaults, per-user pins, fallback chain editor

The chain editor states plainly that its ordered list — not the inventory listing
order — becomes agents.defaults.model_fallbacks, and that every model in it gets
its key written into each workspace using the primary. That consequence has to be
visible where the decision is made.

Candidates exclude the model itself and every non-active model: the resolver skips
a non-active fallback anyway, so offering one would let an admin build a chain that
silently does nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 21: point the native model-secret picker at the inventory

**Files:**
- Modify: `WEBAPP/app/admin/shared-secrets-panel.tsx`

**Interfaces:**
- Consumes: T17 `listModels`.
- Produces: no new exports.

- [ ] **Step 1: Find how the panel currently sources model names**

Run:

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
grep -n "model_list\|model-list\|models" app/admin/shared-secrets-panel.tsx
```

Note each place a model name is offered for the native `model_list.<model>.api_keys` slot.

- [ ] **Step 2: Replace the source**

Wherever the panel builds that list, replace the source with `listModels(routed)` from `@/lib/models`, offering `m.model_name` for every model whose `status !== "disabled"`. Keep the existing select markup and error handling; only the data source changes.

Add a one-line hint next to the select:

```tsx
<span className="text-[11px] text-fg-muted">
  Setting a key here overrides the inventory&apos;s own key for this model, in this scope only.
</span>
```

That sentence is the whole reason the slot still exists: without it an admin cannot tell why two places hold a key for the same model.

- [ ] **Step 3: Verify the proxy agrees**

The proxy now validates this slot against the inventory (T15), so a name from this list always passes and a hand-typed one may not. Confirm the select has no free-text escape hatch; if it does, remove it.

- [ ] **Step 4: Run the tests, type-check and build**

Run: `cd WEBAPP && yarn vitest run && yarn tsc --noEmit && yarn next build 2>&1 | tail -20`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
git add app/admin/shared-secrets-panel.tsx
git commit -m "feat(admin): native model-secret picker reads the inventory

The proxy now validates this slot against the inventory, so the picker must offer
inventory names and nothing else — a hand-typed name would be rejected. The hint
explains why a second place can hold a key for the same model: it is a
scope-limited override of the inventory key, not a competing source.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Proxy gate**

Run:
```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
go mod tidy && go vet ./... && go test ./...
```
Expected: all pass — this is exactly what the Docker build runs.

- [ ] **Webapp gate**

Run:
```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-exoskeleton-webapp
yarn tsc --noEmit && yarn vitest run && yarn next build
```
Expected: all pass.

- [ ] **Gateway config parses**

Run:
```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
python3 -c "import tomllib
for p in ['fungi/mycelium/config.base.toml','fungi/mycelium/config.standalone.toml']:
    tomllib.load(open(p,'rb')); print(p,'ok')"
```

- [ ] **No key can reach a client**

Run:
```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
grep -rn "api_key" --include="*.go" internal/httpapi/ | grep -v _test
```
Expected: only the `modelRequest.APIKey` request field. Any `api_key` on a response path is a defect.

- [ ] **Bump the submodule pointers and record the decision**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project
git add crab/crab-shell-proxy crab/crab-exoskeleton-webapp
git commit -m "chore: bump submodules for the model registry source of truth

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Then add an `AD-013` entry to `.specs/project/STATE.md` following the format of `AD-012`, recording: the single-source-of-truth decision and the clobber it removes; per-model declared fallback chains and why the global-ordered-list shape was rejected; that `config.yaml`'s `agent.Model` is now a migration seed with no runtime effect; that hermes still reads it; and the two deploy steps below.

## Deploy steps (operator, in order)

1. **Reload the mycelium gateway** so the new admin paths route (T16). Without this the admin UI reports "Request path does not match any service".
2. **Restart the proxy once** so `Reconcile` runs the migration. Watch the log for `migrate models:` lines — any `ImportedOrphan` recovery names a model an admin should review, and any `model drift:` line names a workspace whose recorded model disagrees with its config.json.
3. **Verify before touching anything in the UI:** no workspace's active model changed. `docker exec` into one running container's workspace and confirm `config.json`'s `agents.defaults.model_name` is what it was, and that `<dataRoot>/templates/<agent>/config.json.pre-registry` exists.
4. **Register at least one model and set a global default** before any new user signs up — a workspace with no resolvable model is refused at provision, by design.





