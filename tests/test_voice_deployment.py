import importlib.util
import subprocess
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "voice_deployment", Path(__file__).resolve().parents[1] / "admin/deploy_voice_practice.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VoiceDeploymentTests(unittest.TestCase):
    def test_game_saves_require_api_keys_and_only_read_existing_marks(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        function = source["Resources"]["VoicePracticeFunction"]["Properties"]
        for event, method in [("GameSaveGet", "GET"), ("GameSavePost", "POST")]:
            route = function["Events"][event]["Properties"]
            self.assertEqual(route["Path"], "/game/save")
            self.assertEqual(route["Method"], method)
            self.assertNotIn("Auth", route)
        self.assertEqual(function["Environment"]["Variables"]["PASSED_TEST_TABLE"], {"Ref": "PassedTestTable"})
        permissions = [statement for statement in function["Policies"][0]["Statement"]
                       if statement["Resource"] == {"Fn::GetAtt": ["PassedTestTable", "Arn"]}]
        self.assertEqual([statement["Action"] for statement in permissions], ["dynamodb:Query"])
        table = source["Resources"]["VoicePracticeTable"]
        self.assertEqual(table["DeletionPolicy"], "Retain")
        self.assertEqual(table["UpdateReplacePolicy"], "Retain")

    def test_wallet_and_cast_routes_use_existing_auth_and_scoped_permissions(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        function = source["Resources"]["VoicePracticeFunction"]["Properties"]
        for event, path, method in [("DesktopWallet", "/voice/wallet", "GET"),
                                    ("DesktopCast", "/voice/casts", "POST")]:
            route = function["Events"][event]["Properties"]
            self.assertEqual(route["Path"], path)
            self.assertEqual(route["Method"], method)
            self.assertNotIn("Auth", route)
        action = function["Events"]["DesktopAction"]["Properties"]
        self.assertEqual(action["Path"], "/voice/sessions/{id}/{action}")
        self.assertNotIn("Auth", action)
        statements = function["Policies"][0]["Statement"]
        for statement in statements:
            self.assertNotEqual(statement["Resource"], "*")
            actions = statement["Action"]
            if isinstance(actions, str):
                actions = [actions]
            self.assertFalse(any(action.endswith(":*") for action in actions))

    def test_completion_summary_requires_existing_api_key_authentication(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        route = source["Resources"]["VoicePracticeFunction"]["Properties"]["Events"]["DesktopCompletions"]
        self.assertEqual(route["Properties"]["Path"], "/voice/completions")
        self.assertEqual(route["Properties"]["Method"], "GET")
        self.assertNotIn("Auth", route["Properties"])
        self.assertTrue(source["Resources"]["ApiGatewayApi"]["Properties"]["Auth"]["ApiKeyRequired"])

    def test_browser_only_backend_has_no_recording_permissions_or_configuration(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        function = source["Resources"]["VoicePracticeFunction"]["Properties"]
        self.assertNotIn("VOICE_AUDIO_BUCKET", function["Environment"]["Variables"])
        for statement in function["Policies"][0]["Statement"]:
            actions = statement["Action"]
            if isinstance(actions, str):
                actions = [actions]
            self.assertFalse(any(action.startswith(("s3:", "transcribe:")) for action in actions))
        bucket = source["Resources"]["VoiceAudioBucket"]
        self.assertNotIn("CorsConfiguration", bucket["Properties"])
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["Properties"]["LifecycleConfiguration"]["Rules"][0]["ExpirationInDays"], 1)

    def test_service_created_log_groups_are_configured_idempotently_and_never_deleted(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        code = source["Resources"]["VoiceLogConfigurator"]["Properties"]["Code"]["ZipFile"]
        script = """
          const assert = require("node:assert/strict");
          const calls = [];
          const command = name => class { constructor(input) { this.name=name; this.input=input; } };
          const mockSDK = {
            CloudWatchLogsClient: class { async send(command) {
              calls.push(command);
              if (command.name === "create" && command.input.logGroupName === "default")
                throw Object.assign(new Error(), {name:"ResourceAlreadyExistsException"});
            } },
            CreateLogGroupCommand: command("create"),
            AssociateKmsKeyCommand: command("encrypt"),
            PutRetentionPolicyCommand: command("retain")
          };
          let result;
          global.fetch = async (url, request) => {
            result = JSON.parse(request.body);
            return {ok:true};
          };
        """ + code.replace('require("@aws-sdk/client-cloudwatch-logs")', "mockSDK") + """
          (async () => {
            const event = {RequestType:"Create", ResponseURL:"https://example.invalid",
              ResourceProperties:{LogGroupNames:["default","live"],KmsKeyId:"key",RetentionInDays:14}};
            await exports.handler(event);
            assert.equal(result.Status, "SUCCESS");
            assert.deepEqual(calls.map(x=>x.name), ["create","encrypt","retain","create","encrypt","retain"]);
            assert.equal(calls[2].input.retentionInDays, 14);
            calls.length = 0;
            await exports.handler({...event, RequestType:"Delete"});
            assert.equal(result.Status, "SUCCESS");
            assert.equal(calls.length, 0);
          })().catch(error=>{console.error(error);process.exitCode=1;});
        """
        subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
        self.assertIn("VoiceAgentLogGroup", source["Resources"]["VoicePracticeFunction"]["DependsOn"])
        policy = source["Resources"]["VoiceLogKey"]["Properties"]["KeyPolicy"]["Statement"][1]
        contexts = policy["Condition"]["ArnLike"]["kms:EncryptionContext:aws:logs:arn"]
        self.assertTrue(any("VoiceLogConfigurator-" in item["Fn::Sub"] for item in contexts))
        statements = source["Resources"]["VoiceLogConfiguratorRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        permissions = [item for item in statements if "kms:DescribeKey" in item["Action"]]
        self.assertEqual(len(permissions), 1)
        self.assertEqual(permissions[0]["Resource"], {"Fn::GetAtt": ["VoiceLogKey", "Arn"]})
        self.assertIn("kms:ViaService", permissions[0]["Condition"]["StringEquals"])

    def test_node_runtime_uses_single_javascript_entrypoint(self):
        root = Path(__file__).resolve().parents[1]
        source = module.yaml.load((root / "template.yaml").read_text(), Loader=module.CfnLoader)
        code = source["Resources"]["VoiceAgentRuntime"]["Properties"]["AgentRuntimeArtifact"]["CodeConfiguration"]
        self.assertEqual(code["Runtime"], "NODE_22")
        self.assertEqual(code["EntryPoint"], ["server.js"])
        self.assertTrue((root / "src/VoiceAgent/server.js").is_file())

    def test_existing_code_and_marks_are_unchanged(self):
        deployed = {"Resources": {
            "ApiGatewayApi": {"Properties": {"Auth": {"ApiKeyRequired": True}}},
            "GameFunction": {"Properties": {"CodeUri": "s3://existing/grader.zip"}},
            "PassedTestTable": {"Properties": {"BillingMode": "PAY_PER_REQUEST"}},
        }, "Parameters": {"SecretHash": {"Type": "String"}}}
        source = {"Resources": {
            "GameFunction": {"Properties": {"CodeUri": "./src/ServerlessAPI"}},
            "VoicePracticeFunction": {"Properties": {"CodeUri": "./src/VoicePractice"}},
        }, "Parameters": {"EnableVoicePractice": {"Type": "String"}},
            "Description": "Optional oral practice."}
        result = module.additive_template(deployed, source, "s3://new/voice.zip")
        self.assertEqual(result["Resources"]["GameFunction"], deployed["Resources"]["GameFunction"])
        self.assertEqual(result["Resources"]["PassedTestTable"], deployed["Resources"]["PassedTestTable"])
        self.assertEqual(result["Resources"]["VoicePracticeFunction"]["Properties"]["CodeUri"], "s3://new/voice.zip")
        self.assertNotIn("VoicePracticeFunction", deployed["Resources"])
        auth = result["Resources"]["ApiGatewayApi"]["Properties"]["Auth"]
        self.assertTrue(auth["ApiKeyRequired"])
        self.assertFalse(auth["AddApiKeyRequiredToCorsPreflight"])

    def test_changeset_rejects_grader_updates_and_replacements(self):
        module.allowed_changes([{"ResourceChange": {"LogicalResourceId": "VoicePracticeFunction"}}])
        for name in ("GameFunction", "PassedTestTable", "WebAppS3Bucket"):
            with self.assertRaises(RuntimeError):
                module.allowed_changes([{"ResourceChange": {"LogicalResourceId": name}}])
        with self.assertRaises(RuntimeError):
            module.allowed_changes([{"ResourceChange": {
                "LogicalResourceId": "VoicePracticeTable", "Replacement": "True"}}])


if __name__ == "__main__":
    unittest.main()
