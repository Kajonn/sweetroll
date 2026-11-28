#!/usr/bin/env python3
"""Run a Sweetroll campaign with two accounts using only the public API.

The GM token needs all six scopes. The player token needs characters:read,
characters:write, campaigns:read and campaigns:write. Both must belong to
different accounts.
"""

import argparse
import base64
import json
import os
import struct
import zlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4


class NoRedirects(HTTPRedirectHandler):
    # Never forward the credential to a redirect destination.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def solid_png(width, height, rgb):
    """A small opaque PNG for the scene background, built with the standard library."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def client_for(root, token):
    opener = build_opener(NoRedirects())

    def call(method, path, body=None):
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(root + path, data=payload, headers=headers, method=method)
        try:
            with opener.open(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            raise SystemExit(f"{method} {path} returned HTTP {error.code}\n{error.read().decode('utf-8')}") from None

    return call


def key():
    return str(uuid4())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--document", type=Path, default=(
        Path(__file__).resolve().parent.parent / "docs/contracts/examples/d20-system-document-v1.json"
    ))
    parser.add_argument("--no-scene", action="store_true",
                        help="skip the scene step, for servers without an image scanner")
    args = parser.parse_args()
    gm_token = os.environ.get("SWEETROLL_GM_TOKEN")
    player_token = os.environ.get("SWEETROLL_PLAYER_TOKEN")
    if not gm_token or not player_token:
        parser.error("set SWEETROLL_GM_TOKEN and SWEETROLL_PLAYER_TOKEN to tokens from two accounts")
    root = args.base_url.rstrip("/") + "/api/v1"
    gm = client_for(root, gm_token)
    player = client_for(root, player_token)

    # 1. The GM publishes a system and shares it by link so the player can use it.
    document = json.loads(args.document.read_text(encoding="utf-8"))
    created = gm("POST", "/systems", {"name": document["metadata"]["name"], "idempotencyKey": key()})
    system_id = created["system"]["systemId"]
    draft = gm("PUT", f"/systems/{system_id}/draft", {"expectedRevision": created["draft"]["revision"], "document": document})
    version_id = gm("POST", f"/systems/{system_id}/publish", {
        "expectedRevision": draft["draft"]["revision"], "semanticVersion": "1.0.0", "idempotencyKey": key(),
    })["versionId"]
    gm("PUT", f"/systems/{system_id}/sharing", {"access": "link"})

    # 2. The GM creates a campaign and invites the player, who reviews and accepts.
    campaign = gm("POST", "/campaigns", {"systemVersionId": version_id, "title": "API quickstart campaign", "idempotencyKey": key()})
    campaign_id = campaign["campaignId"]
    invitation = gm("POST", f"/campaigns/{campaign_id}/invitations", {
        "intendedRole": "player", "expectedCampaignRevision": campaign["revision"], "idempotencyKey": key(),
    })
    review = player("POST", "/invitations/review", {"token": invitation["token"]})
    player("POST", "/invitations/accept", {
        "campaignId": campaign_id, "token": invitation["token"],
        "expectedInvitationRevision": review["invitationRevision"],
        "reviewedAccessRevision": review["accessRevision"], "idempotencyKey": key(),
    })

    # 3. The player creates a character and adopts it into the campaign.
    entity_id = document["entities"][0]["id"]
    character = player("POST", "/characters", {
        "name": "Quickstart hero", "systemVersionId": version_id, "entityDefinitionId": entity_id, "idempotencyKey": key(),
    })
    character_id = character["characterId"]
    current = player("GET", f"/campaigns/{campaign_id}")
    sheet = player("POST", f"/campaigns/{campaign_id}/characters/{character_id}/adopt", {
        "expectedCampaignRevision": current["revision"], "expectedCharacterRevision": character["revision"],
        "acknowledgedDisclosure": True, "idempotencyKey": key(),
    })

    # 4. The player rolls for the whole table. A replay with the same key returns the same roll.
    action = next(action for action in document["actions"] if action["kind"] == "roll")
    roll_body = {"inputs": {}, "audience": "campaign", "expectedRevision": sheet["revision"], "idempotencyKey": key()}
    rolled = player("POST", f"/characters/{character_id}/actions/{action['id']}", roll_body)
    if player("POST", f"/characters/{character_id}/actions/{action['id']}", roll_body) != rolled:
        raise SystemExit("Replaying the roll returned a different result.")
    # The GM finds the saved roll in the character and campaign activity feeds.
    history = gm("GET", f"/characters/{character_id}/activity")
    seen = next((event for event in history["events"]
                 if event["characterRevision"] == rolled["revision"] and event["rollId"] is not None), None)
    table = gm("GET", f"/campaigns/{campaign_id}/activity")
    if seen is None or seen["rollId"] not in [event["sourceRollId"] for event in table["events"]]:
        raise SystemExit("The GM does not see the campaign roll in the activity feeds.")

    # 5. The GM shares a note and a template; the player proposes an item and the GM approves it.
    gm("POST", f"/campaigns/{campaign_id}/content", {
        "title": "Rumor", "body": "The bridge is watched.", "audience": "all_players", "idempotencyKey": key(),
    })
    gm("POST", f"/campaigns/{campaign_id}/item-templates", {
        "kind": "item", "content": {"name": "Lantern"}, "idempotencyKey": key(),
    })
    proposal = player("POST", f"/campaigns/{campaign_id}/item-proposals", {
        "kind": "item", "content": {"name": "Grappling hook"}, "idempotencyKey": key(),
    })
    decision = gm("POST", f"/campaigns/{campaign_id}/item-proposals/{proposal['proposalId']}/approve", {
        "expectedProposalRevision": proposal["revision"], "idempotencyKey": key(),
    })

    # 6. The GM builds a scene and mints a code for the table display.
    scene_id = code = None
    if not args.no_scene:
        image = gm("POST", f"/campaigns/{campaign_id}/images", {
            "name": "Map", "contentType": "image/png", "idempotencyKey": key(),
            "dataBase64": base64.b64encode(solid_png(64, 64, (20, 90, 160))).decode("ascii"),
        })
        scene = gm("POST", f"/campaigns/{campaign_id}/scenes", {"backgroundFileId": image["fileId"], "idempotencyKey": key()})
        scene = gm("POST", f"/scenes/{scene['sceneId']}/fog-edits", {
            "op": {"mode": "reveal", "runs": [{"x": 0.5, "y": 0.5, "r": 0.3}]},
            "expectedSceneRevision": scene["revision"], "idempotencyKey": key(),
        })
        for label, visible in (("Hero", True), ("Ambush", False)):
            scene = gm("POST", f"/scenes/{scene['sceneId']}/tokens", {
                "label": label, "x": 0.5, "y": 0.5, "size": 0.1, "visible": visible, "imageFileId": None,
                "expectedSceneRevision": scene["revision"], "idempotencyKey": key(),
            })
        code = gm("POST", f"/campaigns/{campaign_id}/display-codes")["code"]
        scene_id = scene["sceneId"]

    print(json.dumps({
        "campaignId": campaign_id, "characterId": character_id, "rollId": seen["rollId"],
        "approvedTemplateId": decision["template"]["templateId"], "sceneId": scene_id,
        "displayCode": code,
    }, indent=2))


if __name__ == "__main__":
    main()
