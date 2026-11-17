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
  └─ no session, cookie, file, database, or cache
          │ bearer token forwarded; redirects disabled
          ├─ GET /api/metadata/v1/objects
          ├─ GET /api/schema/v1/objects/{objectName}
          ├─ GET /api/metadata/v1/objects/{objectName}/fields/{fieldName}/dependency-fields
          └─ GET /api/extensibility/v1/servicehooks/rules
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

Formula relationships derived from `ExpressionDependency` and dependency metadata are labeled Exact. Service Hooks are labeled Exact only when the configured condition contains a boundary-safe match for `Object.Field` or `Field`. Merely targeting the same object is not called field usage. Those object-scoped hooks are counted and surfaced as a limitation because their custom code is not analyzed.

## Storage boundary

The application does not persist bearer tokens, tenant metadata, queries, selected identities, scan definitions, or scan results. Browser state and backend request objects are transient memory only. Reverse proxies and APM products must also be configured not to log request bodies.
