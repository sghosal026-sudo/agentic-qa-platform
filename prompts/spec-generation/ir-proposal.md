Plan the API test for this manual test case.

## The test case

{{testCase}}

## The obligations you must account for

{{obligations}}

## Retrieved knowledge-graph context

This context explains the case's requirements, relationships, risks, and provenance. Use it to
understand the case and preserve its intent. It does not authorize an API operation, request field,
database column, UI element, or assertion by itself; those must still be grounded in the evidence
catalogues below. Do not borrow obligations from sibling cases.

{{graphContext}}

## The operations available to you

These are the only operations that exist. Each shows the id you must use, what it does, the
parameters and body fields it accepts, and the responses its document declares.

{{operations}}

## Authentication available to the plan

Authentication is an ordinary grounded part of the complete IR, just like API, UI, and database
operations. Before any secured API request, choose exactly one mechanism:

- Use `auth.api` when a documented unauthenticated operation returns a token. Supply only grounded
  request values, and set `tokenPath` to a field declared by that response.
- Otherwise use `auth.header` only when the case supplies clearly named authentication test data,
  or an earlier grounded operation returns the token. Put that source in `token`, and copy the
  grounded `headerName` and `scheme` so the IR explicitly states how later requests carry it.
- If neither mechanism is available, use `auth.unavailable` with a precise reason. The case will be
  rendered as `test.fixme`, not as an executable test that predictably receives 401.

Never read values from environment variables. Never invent a login route, credentials, token
field, header, or scheme. If any required step or value source is ambiguous, account for its
obligation in `unautomatable`; for missing authentication, use `auth.unavailable`. Such a case must
be non-executable.

{{authentication}}

## The database tables available to you

A `db.read` finds rows; an assertion then checks how many there are, or a column of the first one.
Use this only when the manual case asks about what was *persisted* — "a row exists", "the record
is saved", "it is written to the audit log". Do not reach for it to check something the API already
answered: if the response says the code is `WH-01`, assert on the response.

The connection is read-only, and you do not write SQL: you name a table, a column and a comparison.

{{tables}}

## The screens available to you

Only screens and elements a person has approved can be used. If the case needs a control that is
not listed here, that obligation is unautomatable — say so and name the control. Do not substitute
a different element because it looks close.

You name a screen and an element. You never write a selector; the renderer looks up how each
element is found.

{{screens}}

## The shape of your answer

{{schema}}

## Worked example

A case whose data is `code = WH-01` and whose steps are "create a warehouse with the test data"
(expecting 201) and "read it back" (expecting the same code):

```json
{
  "caseId": "TestCase:example",
  "layer": "api",
  "ops": [
    {
      "kind": "auth.header",
      "id": "authenticated",
      "token": { "testData": "administrator bearer token" },
      "headerName": "Authorization",
      "scheme": "Bearer",
      "evidenceRefs": ["auth:http-bearer:HTTPBearer"]
    },
    {
      "kind": "api.request",
      "id": "created",
      "step": 1,
      "operationId": "create_warehouse_warehouses_post",
      "body": { "code": { "testData": "code" }, "name": { "testData": "name" } },
      "evidenceRefs": ["api:create_warehouse_warehouses_post"]
    },
    {
      "kind": "api.request",
      "id": "fetched",
      "step": 2,
      "operationId": "get_warehouse_warehouses__warehouse_id__get",
      "pathParams": { "warehouse_id": { "from": "created", "path": "id" } },
      "evidenceRefs": ["api:get_warehouse_warehouses__warehouse_id__get"]
    }
  ],
  "assertions": [
    {
      "kind": "assert.status",
      "obligation": "example.step-1",
      "of": "created",
      "status": 201,
      "evidenceRefs": ["api:create_warehouse_warehouses_post#responses/201"]
    },
    {
      "kind": "assert.body.field",
      "obligation": "example.step-2",
      "of": "fetched",
      "path": "code",
      "matcher": "equals",
      "value": { "testData": "code" },
      "evidenceRefs": ["api:get_warehouse_warehouses__warehouse_id__get#responses/200"]
    }
  ],
  "unautomatable": []
}
```

Note what the example does *not* do: it does not invent a warehouse id, it reads one from the
response of its own first call.

For an obligation saying two created IDs must differ, put the assertion on the later response so
the earlier response is a valid grounded value:

```json
{
  "kind": "assert.body.field",
  "obligation": "example.step-3",
  "of": "secondCreated",
  "path": "id",
  "matcher": "notEquals",
  "value": { "from": "firstCreated", "path": "id" },
  "evidenceRefs": ["api:create_warehouse_warehouses_post#responses/201"]
}
```

Two `exists` assertions do not prove this comparison. When creating persistent records whose key
must be unique, use `{ "uniqueTestData": "the supplied key name" }` instead of changing or inventing
the source test data.

Answer with the JSON object for the case above, and nothing else.
