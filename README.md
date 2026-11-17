# Conga Field Usage Analyzer — standalone internal web application

Version 0.5 is a testable standalone build with searchable tenant metadata plus Formula Dependency and Service Hook condition scans. It has no Chrome extension or Conga TS Inspector integration.

## Run

Requires Node.js 20 or newer.

```bash
npm start
```

Open `http://localhost:4100`, enter an approved Conga Platform API URL, and paste a current bearer token.

## Search behavior

Object and field selection use searchable comboboxes rather than fixed dropdowns:

- **Objects:** searched by label or API name and displayed as `Object Label - API name`.
- **Fields:** searched by label, API name, or data type and displayed as `Label - API name - Data type`.
- Object search follows every metadata page before filtering, so matches after the first 200 objects are included.
- Field search reads the complete `FieldMetadata` collection for the selected object before filtering, so matches after the first 200 fields are included.
- Up to 50 matching rows are returned to the browser per search, together with total match and total scanned counts.

Because persistent metadata storage is prohibited, each search re-reads the required live Platform metadata. Rapid UI input is debounced and stale responses are ignored.

## Usage scan

**Find usage** runs two request-scoped collectors:

1. **Formula dependencies**
   - Shows what the selected field depends on when it is a formula.
   - Finds formula fields in the selected object's full schema whose `ExpressionDependency` references the selected field.
   - Calls the Platform dependency-fields metadata endpoint and merges additional dependent-field results without duplicates.
2. **Service Hook conditions**
   - Pages through every accessible Service Hook rule.
   - Filters to the selected object.
   - Reports exact field-token references in configured hook conditions.
   - Shows active state, events, project, class, and method when returned by Platform.

3. **Workflow references**
   - Pages through `POST /api/workflow/v1/query/WorkflowDefinition?IncludeTotalCount=true` (`IsLatest=true`, all workflow types).
   - Reads each definition from `GET /api/workflow/v1/workflow-definitions/{definitionId}/Latest`, five at a time.
   - Checks every activity property expression (Liquid, Literal, Json, …) plus variables and custom attributes:
     - `Object.Field` anywhere → **Exact**.
     - A Json `Key`/`FieldName` equal to the field, in a workflow on the selected object updating its context object → **Exact** (e.g. `FieldsToUpdate`).
     - The bare field name as a whole word, in a workflow on the selected object → **Probable**.
   - Usage is labelled Condition, Field update, Field mapping, Expression or Variable from the property name.
   - If the workflow API is unavailable, or a definition cannot be read, the collector reports `failed`/`partial` in limitations; the other collectors still return.

Object-level hooks whose condition does not reference the field are counted but not claimed as field usage. Their custom code is not analyzed in this build, and the UI states that limitation.

## No persistent storage

No bearer token, tenant metadata, scan definition, or scan result is persistently stored:

- No server sessions, cookies, files, database records, Redis, or application cache.
- No localStorage, sessionStorage, IndexedDB, cookies, or Service Worker cache.
- Every API operation requires Platform URL and bearer token again.
- The browser retains the active connection and rendered results only in current-page runtime memory.
- Disconnect, reload, navigation, or tab close clears that runtime state.
- Responses and browser fetches use `Cache-Control: no-store` / `cache: no-store`.

Transient request memory necessarily exists while executing a request; the backend keeps no reference after responding.

## Platform URL policy

The URL must use HTTPS, contain only an origin, use the standard HTTPS port, and match an approved Conga host. Paths, queries, fragments, embedded credentials, arbitrary hosts, localhost, IP literals, and lookalike suffixes are rejected before outbound access. Redirects are disabled.

Built-in production origins:

- `https://rls.congacloud.com`
- `https://rls.congacloud.eu`
- `https://rls.congacloud.au`

An approved exact private-gateway hostname can be added with:

```bash
CONGA_ALLOWED_PLATFORM_HOSTS=approved-gateway.example.internal
```

Wildcards are not supported.

## Reference links

Usage-scan results show the record **ID** returned by the Platform API and, when a URL template is configured, link the result name to its page in the Conga admin UI (opens in a new tab). Set the templates in `.env` (loaded automatically on Node 20.12+) or the shell:

```bash
CONGA_SERVICE_HOOK_URL_TEMPLATE={platformUrl}/path/to/service-hooks/{id}
CONGA_FIELD_URL_TEMPLATE={platformUrl}/path/to/objects/{objectName}/fields/{fieldName}
CONGA_WORKFLOW_URL_TEMPLATE={platformUrl}/workflow/{id}/   # default when unset
```

Placeholders: `{platformUrl}` (the connected tenant origin), `{id}`, `{objectName}`, `{fieldName}`, `{name}`. Values are URL-encoded. If a placeholder has no value for a result (for example the API returned no `Id`), that result is shown as plain text instead of a broken link. Copy the address of a real record page in your tenant to get the exact path.

## Verify

```bash
npm run check
```

The integration suite uses a local mock tenant containing 251 objects, 251 fields, and 202 Service Hooks to prove search and scanning continue beyond 200 without calling a real tenant.

## Current boundary

Workflow, callback source, and custom-code analysis are not implemented. A tenant-wide asynchronous index would require approved encrypted job storage; this no-storage build instead performs synchronous, request-scoped scans.
