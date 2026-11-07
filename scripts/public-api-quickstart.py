#!/usr/bin/env python3
"""Create and edit a standalone Sweetroll character using only the public API."""

import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4


class NoRedirects(HTTPRedirectHandler):
    # Never forward the credential to a redirect destination.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--document", type=Path, default=(
        Path(__file__).resolve().parent.parent / "docs/contracts/examples/d20-system-document-v1.json"
    ))
    args = parser.parse_args()
    token = os.environ.get("SWEETROLL_API_TOKEN")
    if not token:
        parser.error("set SWEETROLL_API_TOKEN to a token with all four workflow scopes")
    root = args.base_url.rstrip("/") + "/api/v1"
    client = build_opener(NoRedirects())

    def call(method, path, body=None):
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(root + path, data=payload, headers=headers, method=method)
        try:
            with client.open(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            raise SystemExit(f"{method} {path} returned HTTP {error.code}\n{error.read().decode('utf-8')}") from None

    document = json.loads(args.document.read_text(encoding="utf-8"))
    assessment = call("POST", "/systems/validate", {"document": document})
    if not assessment["valid"]:
        raise SystemExit(json.dumps(assessment["diagnostics"], indent=2))
    # The example uses an integer field with at least three valid values.
    entity_definition = document["entities"][0]
    candidate = next((
        field for field in entity_definition["fields"]
        if field["kind"] == "integer" and field["min"] + 2 * field["step"] <= field["max"]
    ), None)
    if candidate is None:
        raise SystemExit("The first entity needs an integer field with at least three valid values.")
    created = call("POST", "/systems", {
        "name": document["metadata"]["name"], "idempotencyKey": str(uuid4()),
    })
    system_id = created["system"]["systemId"]
    draft = call("PUT", f"/systems/{system_id}/draft", {
        "expectedRevision": created["draft"]["revision"], "document": document,
    })
    if not draft["assessment"]["valid"]:
        raise SystemExit(json.dumps(draft["assessment"]["diagnostics"], indent=2))
    version = call("POST", f"/systems/{system_id}/publish", {
        "expectedRevision": draft["draft"]["revision"], "semanticVersion": "1.0.0",
        "idempotencyKey": str(uuid4()),
    })
    version_id = version["versionId"]
    options = call("GET", f"/characters/creation-options?systemVersionId={version_id}")
    entity = next(entity for entity in options["entities"] if entity["id"] == entity_definition["id"])
    field = next(field for field in entity["fields"] if field["id"] == candidate["id"])
    field_id = field["id"]
    initial, updated = [value for value in (
        field["min"], field["min"] + field["step"], field["min"] + 2 * field["step"],
    ) if value != field["default"]][:2]
    create_character = {
        "name": "API quickstart character", "systemVersionId": version_id,
        "entityDefinitionId": entity["id"], "initialValues": {field_id: initial},
        "idempotencyKey": str(uuid4()),
    }
    character = call("POST", "/characters", create_character)
    if call("POST", "/characters", create_character) != character:
        raise SystemExit("Replaying the character creation returned a different result.")
    character_id = character["characterId"]
    edited = call("POST", f"/characters/{character_id}/fields/{field_id}/set", {
        "value": updated, "expectedRevision": character["revision"], "idempotencyKey": str(uuid4()),
    })
    sheet = call("GET", f"/characters/{character_id}")
    if sheet["revision"] != edited["revision"] or sheet["values"][field_id] != updated:
        raise SystemExit("The edited value or revision did not round-trip.")
    print(json.dumps({"systemId": system_id, "versionId": version_id, **edited, "values": sheet["values"]}, indent=2))


if __name__ == "__main__":
    main()
