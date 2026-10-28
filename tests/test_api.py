import os

os.environ["SDATOS_WARM"] = "0"          # no background warm-up during tests

import pytest

from src.interface.app import app


@pytest.fixture()
def client():
    app.config["TESTING"] = True
    return app.test_client()


def test_invalid_json_is_400_not_500(client):
    r = client.post("/api/plan", data="{not json", content_type="application/json")
    assert r.status_code == 400 and "JSON object" in r.get_json()["error"]


def test_non_object_json_is_400(client):
    assert client.post("/api/plan", json=[1, 2, 3]).status_code == 400


def test_seed_is_bounded(client):
    body = {"rocket": "Falcon 9", "target_alt_km": 550, "launch_time": "2025-03-12T06:00", "seed": 10**9}
    r = client.post("/api/plan", json=body)
    assert r.status_code == 400 and "Seed" in r.get_json()["error"]


def test_missing_field_is_400(client):
    r = client.post("/api/plan", json={"rocket": "Falcon 9"})
    assert r.status_code == 400
