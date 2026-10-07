# Repair one accepted TestIR

The accepted plan below failed because of a test binding. Return a complete revised TestIR JSON
object. Change only bindings: operations, their order and arguments, or the operation handle named
by an assertion's `of` field. Do not add, remove, strengthen, weaken, or otherwise rewrite an
assertion. Do not change `caseId`, `layer`, or `unautomatable`.

The assertion-freeze policy checks the returned object. A changed assertion will reject the entire
repair even if it would make the test pass.

## Failure to repair

{{failure}}

## Manual case

{{testCase}}

## Accepted TestIR

{{acceptedIr}}

## Retrieved knowledge-graph context

Use this provenance-labelled context to understand the failed case and choose correct bindings.
It cannot authorize a binding absent from the evidence catalogues, and it cannot justify changing
any frozen assertion or importing an obligation from another case.

{{graphContext}}

## Available API operations

{{operations}}

## Available authentication mechanisms

Authentication is a repairable operation binding and must remain explicit in the complete IR.
Use a documented `auth.api` token operation when possible, otherwise `auth.header` with a token
from named case test data or an earlier grounded response. The IR must name the grounded token
header and scheme explicitly. Never use environment variables. If neither is grounded, use `auth.unavailable`; never invent authentication or
allow a secured request to execute anonymously.

{{authentication}}

## Available database tables

{{tables}}

## Approved UI contract

{{screens}}

## Required JSON schema

{{schema}}

Return only the complete revised TestIR JSON object.
