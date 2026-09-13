"""T02: distribution boundaries must hold independently of frontend policy."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DistributionBoundary(unittest.TestCase):
    def test_independent_identity_and_settings_root(self):
        config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
        package = json.loads((ROOT / 'package.json').read_text())
        self.assertEqual(config['identifier'], 'io.github.aharada54914.mdworkbench')
        self.assertEqual(config['mainBinaryName'], 'md-workbench')
        self.assertEqual(config['productName'], 'MD Workbench')
        self.assertEqual(config['plugins']['deep-link']['desktop']['schemes'], ['md-workbench'])
        self.assertEqual(config['bundle']['windows']['nsis']['installMode'], 'currentUser')
        self.assertEqual(package['name'], 'md-workbench')
        self.assertTrue(package['private'])
        self.assertEqual(package['version'], config['version'])
        # Backend AI data derives from Tauri's application-specific directory.
        self.assertIn('app.path().app_data_dir()', (ROOT / 'src-tauri/src/ai/paths.rs').read_text())

    def test_no_upstream_update_authority(self):
        config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
        self.assertNotIn('updater', config['plugins'])
        self.assertFalse(config['bundle']['createUpdaterArtifacts'])
        self.assertNotIn('tauri_plugin_updater::', (ROOT / 'src-tauri/src/lib.rs').read_text())
        for path in (ROOT / 'src-tauri/capabilities').glob('*.json'):
            for permission in json.loads(path.read_text())['permissions']:
                identifier = permission if isinstance(permission, str) else permission['identifier']
                self.assertFalse(identifier.startswith('updater:'), identifier)

    def test_manual_build_cannot_publish(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('  push:', workflow)
        self.assertIn('contents: read', workflow)
        for forbidden in ['contents: write', 'secrets.', 'action-gh-release', 'releaseId:',
                          'git push', 'git tag', 'gh release', 'TAURI_SIGNING_PRIVATE_KEY']:
            self.assertNotIn(forbidden, workflow)


if __name__ == '__main__':
    unittest.main(verbosity=2)
