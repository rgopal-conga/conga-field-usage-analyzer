# Stateless standalone architecture

```text
Browser page runtime memory only
  ├─ Platform URL + bearer token + optional user-id
  ├─ selected object and field
  └─ currently rendered search/scan results
          │ POST on every operation; no-store
          ▼
Standalone backend — request scope only
  ├─ exact-host Platform URL allowlist and input validation
  ├─ object search: exhaust pages → filter → return top matches
  ├─ field search: fetch complete schema → filter → return top matches
  ├─ formula dependency collector
  ├─ Service Hook condition collector
  ├─ workflow reference collector
  ├─ custom code collector (source held in request memory only)
  └─ no session, cookie, file, database, or cache
          │ bearer token forwarded; redirects disabled
          ├─ GET /api/metadata/v1/objects
          ├─ GET /api/schema/v1/objects/{objectName}
          ├─ GET /api/metadata/v1/objects/{objectName}/fields/{fieldName}/dependency-fields
          ├─ GET /api/extensibility/v1/servicehooks/rules
          ├─ POST /api/workflow/v1/query/WorkflowDefinition
          ├─ GET /api/workflow/v1/workflow-definitions/{definitionId}/Latest
          ├─ GET /api/extensibility/v1/customcode
          ├─ GET /api/extensibility/v1/customcode/{name}
          ├─ GET /api/extensibility/v1/customcode/{name}/download   (ZIP fallback)
          ├─ GET /api/extensibility/v1/callbacks
          ├─ GET /api/extensibility/v1/customcode/api-resource
          └─ GET /api/extensibility/v1/customcode/api-resource/{name}/uri-entries
                    ▼
              Conga Platform
```

## Application API

Every POST requires `platformUrl`, `bearerToken`, and optional `userId`:

- `POST /api/platform/validate`
- `POST /api/platform/objects/search` with `query` and optional `limit`
- `POST /api/platform/fields/search` with `objectName`, `query`, and optional `limit`
- `POST /api/platform/usage-scan` with `objectName` and `fieldName`

Search limits affect only returned matches, not upstream coverage. Object search exhausts pagination before filtering. Field search filters the complete object schema.

## Collector fidelity

Formula relationships derived from `ExpressionDependency` and dependency metadata are labeled Exact. Service Hooks are labeled Exact only when the configured condition contains a boundary-safe match for `Object.Field` or `Field`. Merely targeting the same object is not called field usage. Those object-scoped hooks are counted, and the code they run is checked by the custom code collector.

Custom code matches are labelled Exact when a string literal contains `Object.Field`, or equals the field name in a file that names the object or a class wired to a Service Hook on the object. Matches that depend on project-level context, or that sit in a longer string or a property access, are Probable; field-name literals with no object context are Possible. The collector never compiles or executes code.

## Storage boundary

The application does not persist bearer tokens, tenant metadata, queries, selected identities, scan definitions, or scan results. Browser state and backend request objects are transient memory only. Reverse proxies and APM products must also be configured not to log request bodies.
