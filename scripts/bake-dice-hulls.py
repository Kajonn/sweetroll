"""Rebuild v1 convex collision points in the numbered OBJ models' local frame.

Run with Python and SciPy after updating the source models. Neither the app
build nor the runtime needs the baking tool.
"""

import json
from pathlib import Path

from scipy.spatial import ConvexHull


def bake(obj):
    with obj.open(encoding="utf-8") as mesh:
        vertices = [
            [float(component) for component in line.split()[1:4]]
            for line in mesh if line.startswith("v ")
        ]
    hull = ConvexHull(vertices)
    points = sorted(vertices[i] for i in hull.vertices)
    return "[\n" + ",\n".join("  " + json.dumps(point) for point in points) + "\n]\n"


if __name__ == "__main__":
    models = Path(__file__).resolve().parents[1] / "web/public/dice/v1"
    for sides in (4, 6, 8, 10, 12, 20):
        hull = bake(models / f"{sides}Dice.obj")
        (models / f"d{sides}.hull.json").write_text(hull, encoding="utf-8")
