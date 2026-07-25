# Model Registry Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two competing model-selection systems in `crab-shell-proxy` with one proxy-level model inventory that is the single answer to "which model does this workspace use", tracks which workspaces use which model, blocks deleting or disabling a model in use, and retires an in-use model only via deprecation with a named replacement.

**Architecture:** A new `internal/registry` package owns a bbolt database at `<containerDataRoot>/model-registry.db` with four buckets (`models`, `assignments`, `scope_defaults`, `meta`). One exported `Resolve` walks the cascade user assignment → subscription → tenant → agent → global, following `replaced_by` only for workspaces with no materialized assignment. `internal/docker` materializes the resolved primary plus its declared fallback chain into each workspace's `config.json` (no `api_key`) and `.security.yml` (keys, with pruning). A one-time boot migration seeds the inventory from every pre-existing source and records what each workspace is currently running, so nothing is orphaned.

**Tech Stack:** Go 1.23 (`CGO_ENABLED=0`), `go.etcd.io/bbolt`, `gopkg.in/yaml.v3`, Next.js 15 App Router, TypeScript, Tailwind v4 + class-variance-authority, vitest.

## Global Constraints

- Go module is `github.com/LepistaBioinformatics/crab-shell-proxy`, Go 1.23. `CGO_ENABLED=0` (`Dockerfile:15`) — no cgo-linked dependency is permitted.
- The Docker build **is** the test gate (`Dockerfile:22-23`): `go mod tidy && go vet ./... && go test ./...` must pass or no image is produced.
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
// Enforces I4 (the replacement must exist and be active) and I5 (no cycles).
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
		if repl.Status != StatusActive {
			return fmt.Errorf("%w: replacement %q is %s, so it could not serve new users", ErrInvalid, replacedBy, repl.Status)
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

**Phase A complete.** `internal/registry` is self-contained and fully tested; nothing wires it yet, so the proxy still behaves exactly as before. Phases B–F follow in the sections appended below.

