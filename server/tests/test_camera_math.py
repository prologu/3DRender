import importlib.util
import math
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).resolve().parents[1] / "server_render_api.py"
SPEC = importlib.util.spec_from_file_location("server_render_api", MODULE_PATH)
assert SPEC and SPEC.loader
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class CameraMathTests(unittest.TestCase):
    def view(self, yaw: float, pitch: float) -> np.ndarray:
        return SERVER.RendererState.view_matrix(
            np.array([0.25, -0.5, 1.0], dtype=np.float32),
            yaw,
            pitch,
            4.0,
        )

    def test_basis_is_orthonormal_at_and_beyond_poles(self) -> None:
        for pitch in (
            -math.tau,
            -math.pi,
            -math.pi / 2,
            0.0,
            math.pi / 2,
            math.pi,
            math.tau,
        ):
            rotation = self.view(0.73, pitch)[:3, :3]
            np.testing.assert_allclose(rotation @ rotation.T, np.eye(3), atol=1e-6)
            self.assertTrue(np.isfinite(rotation).all())

    def test_crossing_each_pole_is_continuous(self) -> None:
        epsilon = 1e-5
        for pole in (-math.pi / 2, math.pi / 2):
            before = self.view(-1.17, pole - epsilon)
            after = self.view(-1.17, pole + epsilon)
            np.testing.assert_allclose(before, after, atol=1e-4)

    def test_full_vertical_turn_returns_to_same_view(self) -> None:
        np.testing.assert_allclose(self.view(1.2, 0.0), self.view(1.2, math.tau), atol=1e-6)

    def test_huge_angles_are_reduced_without_precision_loss(self) -> None:
        base = self.view(0.4, -0.7)
        wrapped = self.view(0.4 + 20 * math.tau, -0.7 - 18 * math.tau)
        np.testing.assert_allclose(base, wrapped, atol=1e-5)


if __name__ == "__main__":
    unittest.main()

