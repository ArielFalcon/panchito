---
name: architecture-mapping
description: How to extract the FE↔BE architecture map (routes, API operations, and their joins) from structured sources. Used by the context run mode to build e2e/.qa/context.json. Consult this skill WHENEVER you are asked to build or refresh the architecture map.
---

# Architecture mapping

Craft knowledge for building `e2e/.qa/context.json` — the distilled map that lets future QA
runs cross the frontend→backend boundary without re-deriving the architecture from raw code.

## Hard rules (always)

- **Extract, never invent.** Every route comes from a routing file. Every operation comes from
  an OpenAPI spec. Every FE↔BE link comes from a generated API client. If a source is missing,
  leave that section empty — do not guess.
- **The join is the whole point.** Every `feBe` entry MUST resolve to a known route (in `routes`)
  AND a known operation (in `api`). A dangling link makes the map invalid. Remove it before writing.
- **Keep it small.** This is an E2E authoring aid — not exhaustive documentation. Include only the
  routes/operations that user-facing flows actually touch. Skip internal/admin-only endpoints.
- **One file.** Write `e2e/.qa/context.json` as a single JSON file with `builtAtSha` + 4 sections:
  `routes`, `api`, `feBe`, `flows` (optional).

## Extracting routes (Angular)

Angular routes live in one of two patterns:

### Centralised (Routes array)
```typescript
// src/app/app.routes.ts
export const routes: Routes = [
  { path: "checkout", component: CheckoutPageComponent },
  { path: "products/:id", component: ProductDetailPageComponent,
    children: [
      { path: "reviews", component: ReviewsComponent }
    ] }
];
```
Read `Routes` arrays with serena `find_symbol`. For each route:
- `path` → the URL pattern (concatenate parent + child paths with `/`)
- `component` → the class name (e.g. `CheckoutPageComponent`)
- `source` → the file declaring it

### File-based (standalone components with Route config)
```typescript
// src/app/orders/orders.routes.ts
export default [
  { path: "", component: OrdersPageComponent }
] satisfies Route[];
```
Glob `**/*.routes.ts` with serena and read each. The export is the route array.

### Lazy-loaded routes
```typescript
{ path: "admin", loadChildren: () => import("./admin/admin.routes") }
```
Follow the import to the child routes file. Include the parent path prefix in child route paths.

### What to skip
- Redirects (`redirectTo`)
- Empty/fallback paths (`path: ""`, `path: "**"`) unless they serve a distinct page
- Routes with no component (pure guards)

## Extracting API operations (OpenAPI)

Use serena glob to find OpenAPI specs: `**/openapi*.yaml`, `**/openapi*.json`, `**/swagger*.yaml`, `**/api-definition.yaml`.

For each operation, extract:
- `operationId` → the stable identifier (e.g. `createOrder`)
- `method` → `GET`, `POST`, `PUT`, `DELETE`, `PATCH`
- `path` → the URL template (e.g. `/orders/{id}`)
- `service` → the owning microservice (derive from the spec file path or `tags`)

### YAML reading pattern
```yaml
paths:
  /orders:
    post:
      operationId: createOrder
      tags: [Orders]
      requestBody: ...
  /orders/{id}:
    get:
      operationId: getOrder
      tags: [Orders]
```

Read the whole spec with serena `get_symbols_overview` (for structure) or read the file directly. Extract every operation with an `operationId`.

### Multi-service repos
If one repo contains specs for multiple services (e.g. `api-gateway.yaml` + `order-service.yaml`), extract ALL of them into the same `api` array. Set `service` per entry to distinguish them.

## Creating the FE↔BE join

Generated API clients are the bridge. In Angular, they typically live under `src/app/generated/` or `src/app/api/` and are classes named like `*Client` or `*Service` (e.g. `OrderClient`, `ProductApiService`).

### Pattern 1: Generated TypeScript client (OpenAPI Generator / ng-openapi-gen)
```typescript
// src/app/generated/order-client.ts
export class OrderClient {
  create(body: CreateOrderRequest): Observable<Order> {
    return this.http.post<Order>(`/orders`, body);
  }
}
```
Extract the `operationId` FROM the method name (snake_case → camelCase) or the generated comments/annotations. If the client file has JSDoc with `@operationId`, use that.

### Pattern 2: Service with explicit operation URLs
```typescript
// src/app/services/order.service.ts
orderService.createOrder(body).subscribe(...)
```
Find where the service is injected in a page component, then match the route that renders that component.

### Building the link
For each found client call:
1. Identify the component that calls it (serena `find_referencing_symbols`)
2. Find the route whose `component` matches
3. Create the link: `{ "route": "/checkout", "operationId": "createOrder", "via": "OrderClient.create" }`

## Encoding the flows section (optional)

Group related routes + operations into named flows for readability:
```json
{ "id": "checkout", "routes": ["/cart", "/checkout"], "operations": ["getCart", "createOrder", "processPayment"] }
```

Derive flows from route groupings (e.g. all routes under a shared layout) or OpenAPI tags.

## Self-validation checklist

Before writing `context.json`, verify:
- [ ] Every `route` path is unique
- [ ] Every `operationId` is unique
- [ ] Every `feBe` link's `route` exists in `routes`
- [ ] Every `feBe` link's `operationId` exists in `api`
- [ ] `builtAtSha` is set to the current commit SHA from the prompt
- [ ] No invented/fabricated entries — every line traces back to a structured source
