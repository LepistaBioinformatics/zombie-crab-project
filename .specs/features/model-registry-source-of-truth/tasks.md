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

**Interfaces:**
- Consumes: T07–T09.
- Produces:
  - `(*Manager).ReapplyModelScope(scope Scope) error` — unchanged signature, registry-backed
  - `(*Manager).ReapplyModelUser(key WorkspaceKey) error` — **signature change**: the `agent config.Agent` parameter is gone (the registry needs no agent config)
  - `(*Manager).ReapplyModelForModel(modelName string) error` — new; re-materializes every workspace whose set contains the model
  - `(*Manager).reapplyWorkspace(key WorkspaceKey) error`
- Removed: `resolveModel`, `reapplyModel`, `getModelOverride`, `setModelOverride`, `clearModelOverride`, `EffectiveModel`, `SetModelOverride`, `ClearModelOverride`, `ModelSel`, `ModelTarget`, `modelOverridePath`, `setModelListEntry` callers outside `materialize.go`, `applyModel`, and every `RegisteredModel*` symbol.

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
```

Add `"context"` to the file's imports.

Run `cd PROXY && grep -n "type Docker interface" -A 25 internal/docker/client.go` and adjust the double so it matches the interface exactly — add any missing method returning zero values, and delete any method the interface does not declare.

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

// ReapplyModelScope re-materializes every established workspace under scope, then
// restarts the running ones so picoclaw reloads. A workspace that was never
// provisioned is skipped: resolution already applies at its first provision.
//
// Per-workspace failures are logged and skipped rather than returned, so one bad
// workspace does not block the pass for the others (mirroring RestartScope's own
// best-effort contract).
func (m *Manager) ReapplyModelScope(scope Scope) error {
	keys, err := m.scopeWorkspaceKeys(scope)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err := m.reapplyWorkspace(key); err != nil {
			m.logf("reapply model scope: workspace %+v: %v", key, err)
		}
	}
	return m.RestartScope(scope)
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

- [ ] **Step 9: Run the package tests**

Run: `cd PROXY && go test ./internal/docker/ -v 2>&1 | tail -40`
Expected: PASS. Compile errors will point at remaining `applyModel` / `RegisteredModel` / `ModelSel` references — remove each one; they are all superseded. `internal/httpapi` will still fail to build; that is T13/T14.

- [ ] **Step 10: Commit**

```bash
cd /mnt/external/thirdparty-projects/zombie-crab-project/crab/crab-shell-proxy
git add -A internal/docker/ cmd/
git commit -m "refactor(docker): delete the two competing model systems

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

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

**Phase B complete.** Workspaces are written from the inventory and the old systems are gone. `internal/httpapi` does not compile yet — Phase D fixes it.

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

func TestNormalizeDiskTemplatesIsIdempotentAndKeepsTheFirstBackup() {
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

Delete the empty stub `TestNormalizeDiskTemplatesIsIdempotentAndKeepsTheFirstBackup` — it is covered by `TestNormalizeDiskTemplatesDoesNotOverwriteAnExistingBackup`.

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
func (m *Manager) normalizeDiskTemplates() error {
	seen := map[string]bool{}
	for _, agent := range m.cfg.Agents {
		if agent.Template == "" || seen[agent.Template] {
			continue
		}
		seen[agent.Template] = true
		path := filepath.Join(config.TemplatesDir(m.cfg.ContainerDataRoot, agent.Template), "config.json")
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
func (m *Manager) checkModelDrift() {
	for _, agent := range m.cfg.Agents {
		for _, key := range m.existingWorkspaces(agent.Key) {
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



