# The Legend of AWS Warrior

The Legend of AWS Warrior is a project assignment with AWS Academy Learner Lab. Students need to play the game to get the instruction generated from AWS Bedrock by talking to the NPC girl and kill the monster to trigger unit test in AWS Lambda. It is an AWS SAM application.

[![The Legend of AWS Warrior - Explanation and demonstration](https://img.youtube.com/vi/xuCo3ZiFt-M/0.jpg)](https://www.youtube.com/watch?v=xuCo3ZiFt-M)

[![廣東話 解說示範 The Legend of AWS Warrior Game](https://img.youtube.com/vi/nq4wNlL17Kk/0.jpg)](https://www.youtube.com/watch?v=nq4wNlL17Kk)


## Tech Blog
[The Legend of AWS Warrior: A Free Opensource 3D RPG Adventure Game with Generative AI for learning AWS](https://community.aws/content/2ftYEIAT0IlnPwAhvKhlD4PL52h/behind-the-scene-of-the-legend-of-aws-warrior)


## Deploy the updated application.
For the first time, install AWS SAM CLI and the .NET 8 SDK (x86_64 Linux).
The setup script requires `curl`, `unzip`, `tar`, and `sudo` (unless running as root).
It installs a missing .NET 8 SDK under `~/.dotnet` and installs or updates SAM CLI
system-wide. It stops on errors and removes temporary downloads automatically.
```bash
./aws_sam_setup.sh
```

If .NET was installed under `~/.dotnet`, the setup script prints the environment
exports needed for direct `dotnet` commands. Add them to `~/.bashrc` for future
shells. The package update script discovers this local installation automatically.

```bash
sam build && sam deploy --parameter-overrides "SecretHash=bb14ca5898a4e4133bbce2ea2315a1234"
```
SecretHash can be any string of any length. It will be hashed using SHA256 to derive a proper AES-256 encryption key. 


## Cleanup

To delete the sample application that you created, use the AWS CLI. Assuming you used your project name for the stack name, you can run the following:

```bash
sam delete --stack-name CloudProjectMarker
```

## Packages update

Run `./aws_sam_setup.sh` first, or install the
[.NET 8 SDK for Ubuntu](https://learn.microsoft.com/dotnet/core/install/linux-ubuntu)
(not just the runtime) and ensure `dotnet` is on your `PATH`. Then run:

```
./update_packages.sh
```

The script installs or updates `dotnet-outdated-tool` and upgrades packages in both
.NET projects. It stops on the first error; completion is reported only if all
commands succeed.

## Local regression tests

These tests do not call AWS or execute the infrastructure checks in
`src/ProjectTestsLib/`. The backend tests use NUnitLite, like the application.
Run from the repository root with the .NET 8 SDK, Node.js 22.7+ and Python 3:

```bash
dotnet run --project tests/ServerlessAPI.Tests -- --noresult --workers=0
node --test web-game/tests/core.test.mjs
node --test web-game/tests/v2.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
(cd web-app && CI=true npm test -- --watchAll=false --runInBand)
```

## Resources

See the [AWS SAM developer guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html) for an introduction to SAM specification, the SAM CLI, and serverless application concepts.

Next, you can use AWS Serverless Application Repository to deploy ready to use Apps that go beyond hello world samples and learn how authors developed their applications: [AWS Serverless Application Repository main page](https://aws.amazon.com/serverless/serverlessrepo/)

## Full deployment
You can use any string as the hash (any length).
```
./deploy.sh bb14ca5898a4e4133bbce2ea2315a1000
```

## Deploy the WebApps
Update /web-app/src/Constant.js for the Web Endpoint.
Then, run the following command.

```
cd web-app
npm i
npm run build
npm run deploy
```

## Web Game

Classic remains at `/game.html`; the enhanced beta is at `/game-v2.html`.
The Marks page offers both versions. V2 adds a village, market, forest, lake,
bridge, ruins, minimap, quest markers and adjustable graphics quality.
Both versions share the API key and backend marks. V2 stores its active quest
separately in `sessionStorage`, so it does not overwrite Classic's quest.

Serve the game directory locally, then open either entry point:

```
cd web-game
python3 -m http.server
```

Open `http://localhost:8000/game-v2.html` for V2. Use WASD to move and turn,
Shift to run, Space to attack, E near a guide to get a task, and the mouse wheel to
zoom. You can explore without an API key; set a key to request and grade quests.
Receive new tasks only by pressing E near a character with a golden marker.
Clicking characters or markers does not request tasks, and there is no task-fetch button.
Guide characters walk around their home areas, pause when approached or spoken
to, and keep their golden markers and minimap positions as they move.
Defeated monsters return after a short delay at random walkable locations outside
the village and away from players and other actors. The existing monster pool is
reused so encounters continue without growing the population or accumulating bodies.
V2 keeps a compact task tracker on screen. Full task requirements and NPC
conversations open in a large, scrollable reading window and can be reopened
without losing the current task. Instructions open when you accept a task.
Complete those steps in AWS, then defeat a
monster to grade the task. If grading fails, keep the same task, fix your resources,
and defeat another monster to retry. There is no separate grading button.
The game needs a desktop browser with WebGL and import-map support, and internet
access for the pinned Three.js modules. Low quality disables shadows and ground
decoration. This is a desktop keyboard/mouse beta, not a touch-controls release.

If WebGL cannot start, V2 retries without antialiasing and with WebGL 1 when
instanced rendering is available, using Low quality for compatibility. It does
not require the high-performance GPU. If all attempts fail, enable graphics
acceleration in your browser settings and restart the browser, close other 3D
tabs, or try another browser with an up-to-date graphics driver. Both Classic
and V2 require working WebGL; reducing graphics quality cannot enable disabled
browser graphics.

V2's code and new assets live under `web-game/v2/`; Classic's entry point and
modules are unchanged. The existing deployment uploads both versions together.
Town models are a curated subset of Kenney's CC0 Fantasy Town Kit 2.0
(26 GLBs and a shared texture, about 526 KiB). Their original license and
provenance are included under `web-game/v2/assets/`. Existing characters,
animations, and Quaternius packs are reused without duplicating their files.

## Reset your marks

On the Marks page, choose **Reset my marks** and confirm. This permanently clears
only the authenticated student's passed marks and failed-test history. It keeps
their API key, saved credentials, linked AWS account, and actual AWS resources.
Other students' records are not changed.

Close game tabs and wait for grading to finish first: an in-progress or scheduled
grader can award marks again afterward. A successful reset clears Classic's saved
quest filter and invalidates V2 quests in other tabs in the same browser.
The Home page's **Reset** button only clears locally saved credentials.

The feature requires deploying the `/resetmarks` POST endpoint from `template.yaml`
as well as the rebuilt frontend; a frontend-only deployment is not sufficient.

## Export Marks
Change table name and region.
```
aws dynamodb scan --table-name CloudProjectMarker-PassedTestTable-XXXXXXX --region us-east-1 \
--select ALL_ATTRIBUTES --page-size 500 --max-items 100000 --output json \
| jq -r '.Items' \
| jq -r 'map({Test: .Test.S, User: .User.S, Marks: .Marks.N, Time: .Time.S}) | (.[0] | keys_unsorted) as $keys | $keys, map([.[ $keys[] ]])[] | @csv' \
> marks.csv
```

## Reference 

https://aws.plainenglish.io/deploy-react-web-app-on-aws-s3-and-cloudfront-using-cloudformation-via-aws-sam-cli-409aa479063d

https://github.com/simondevyoutube/Quick_3D_RPG
