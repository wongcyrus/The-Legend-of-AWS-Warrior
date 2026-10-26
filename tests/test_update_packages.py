import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class UpdatePackagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.home = self.directory / "home"
        self.home.mkdir()
        self.log = self.directory / "commands"
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": str(self.bin),
            "COMMAND_LOG": str(self.log),
            "SDK_VERSIONS": "8.0.424 [/example/sdk]",
        }
        for command in ("dirname", "grep"):
            (self.bin / command).symlink_to(shutil.which(command))
        self.dotnet = self.bin / "dotnet"
        self.dotnet.write_text(
            "#!/bin/bash\n"
            'printf "%s|%s\\n" "$PWD" "$*" >> "$COMMAND_LOG"\n'
            'if [[ "$1" == --list-sdks ]]; then\n'
            '    printf "%s\\n" "$SDK_VERSIONS"\n'
            'elif [[ "$1" == tool && "${FAIL_STAGE:-}" == tool ]]; then\n'
            "    exit 17\n"
            'elif [[ "$1" == outdated && "$PWD" == *"${FAIL_STAGE:-never}" ]]; then\n'
            "    exit 18\n"
            "fi\n"
        )
        self.dotnet.chmod(0o755)

    def run_script(self):
        return subprocess.run(
            ["/bin/bash", str(ROOT / "update_packages.sh")],
            cwd=self.directory,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def commands(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_missing_dotnet_has_actionable_error(self):
        self.dotnet.unlink()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("aws_sam_setup.sh", result.stderr)
        self.assertNotIn("completed", result.stdout)

    def test_requires_dotnet_8_sdk_before_installing_tools(self):
        for versions in ("", "9.0.317 [/example/sdk]"):
            with self.subTest(versions=versions):
                self.env["SDK_VERSIONS"] = versions
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(".NET 8 SDK", result.stderr)
                self.assertNotIn("tool install", self.commands())

    def test_updates_both_projects_from_another_directory(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tool install --global dotnet-outdated-tool", self.commands())
        self.assertIn(f"{ROOT}/src/ServerlessAPI|outdated --upgrade", self.commands())
        self.assertIn(f"{ROOT}/src/ProjectTestsLib|outdated --upgrade", self.commands())
        self.assertIn("completed", result.stdout)

    def test_updates_an_existing_tool(self):
        tool = self.bin / "dotnet-outdated"
        tool.write_text("#!/bin/bash\nexit 0\n")
        tool.chmod(0o755)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tool update --global dotnet-outdated-tool", self.commands())
        self.assertNotIn("tool install", self.commands())

    def test_discovers_local_dotnet(self):
        local = self.home / ".dotnet"
        local.mkdir()
        self.dotnet.rename(local / "dotnet")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tool_failure_stops_project_updates(self):
        self.env["FAIL_STAGE"] = "tool"
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("outdated --upgrade", self.commands())
        self.assertNotIn("completed", result.stdout)

    def test_first_project_failure_stops_second_update(self):
        self.env["FAIL_STAGE"] = "ServerlessAPI"
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("src/ProjectTestsLib", self.commands())
        self.assertNotIn("completed", result.stdout)

    def test_second_project_failure_is_not_reported_as_success(self):
        self.env["FAIL_STAGE"] = "ProjectTestsLib"
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("completed", result.stdout)


if __name__ == "__main__":
    unittest.main()
