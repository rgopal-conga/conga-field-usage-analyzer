# Stateless architecture — standalone site and Chrome extension

The same UI (`public/`) and the same API router and scanners (`server/api.js` and the modules it imports) run in two hosts:

```text
Standalone site                                Chrome extension
  public/app.js  request()                       public/app.js  request()
        │ HTTP POST, no-store                           │ in-page call
        ▼                                               ▼
  server/index.js (Node http, static files)      core/api.js  (copy of server/api.js)
        │ api.handle()                                  │
        └──────────────► server/api.js ◄────────────────┘
                          scanners, Conga client, URL allowlist
                                 │ bearer token, redirects disabled
                                 ▼
                           Conga Platform
```

In the extension, `request()` imports `core/api.js` and `extension-config.js` (generated at build time from `.env`) and calls `api.handle()` directly; the manifest's host permissions let the extension page call Conga Platform without CORS. Only `server/index.js` may use Node APIs. The build fails if any other shared module does.

The standalone view below shows the request flow; in the extension the "backend" box runs inside the browser tab.


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
  ├─ workflow reference collector
  ├─ field expression reference collector (CPQ)
  ├─ custom code collector (source held in request memory only;
  │    Service Hook rules read only for "Runs as" wiring)
  └─ no session, cookie, file, database, or cache
          │ bearer token forwarded; redirects disabled
          ├─ GET /api/metadata/v1/objects
          ├─ GET /api/schema/v1/objects/{objectName}
          ├─ GET /api/metadata/v1/objects/{objectName}/fields/{fieldName}/dependency-fields
          ├─ GET /api/extensibility/v1/servicehooks/rules
          ├─ POST /api/workflow/v1/query/WorkflowDefinition
          ├─ GET /api/workflow/v1/workflow-definitions/{definitionId}/Latest
          ├─ POST /api/search/v1/objects/FieldExpression/query?includeTotalCount=true
          ├─ GET /api/revenue-admin/v1/field-expressions/{id}
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

Field expression matches read only `UpdateField` (from `UpdateObject`), `ConditionExpression`/`Expression` (`$.Path` from `SourceObject`, quoted literals ignored) and `GroupByField`/`ParentField`. Paths are resolved through lookup fields in the tenant schemas: resolving to the selected object, or naming it as `Object.Field`, is Exact; an unresolved relationship, a bare name without `$.`, or a label-valued `UpdateField` equal to the field label is Probable. Record metadata, scope and product names are never matched.

Formula relationships derived from `ExpressionDependency` and dependency metadata are labeled Exact. Service Hooks are not reported as a separate collector: the code each hook runs is checked by the custom code collector, and the hook is shown under "Runs as". A hook on the selected object whose condition contains a boundary-safe match for `Object.Field` or `Field` is added to the custom code results with access Condition, labelled Exact.

Custom code matches are labelled Exact when a string literal contains `Object.Field`, or equals the field name in a file that names the object or a class wired to a Service Hook on the object. Matches that depend on project-level context, or that sit in a longer string or a property access, are Probable; field-name literals with no object context are Possible. The collector never compiles or executes code.

## Storage boundary

The application does not persist bearer tokens, tenant metadata, queries, selected identities, scan definitions, or scan results. Browser state and backend request objects are transient memory only. Reverse proxies and APM products must also be configured not to log request bodies.
