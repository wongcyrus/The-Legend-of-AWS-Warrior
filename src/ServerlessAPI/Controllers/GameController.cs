using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;

namespace ServerlessAPI.Controllers;

[DataContract]
public class GameTaskData
{
    [DataMember] public int GameClassOrder { get; set; }
    [DataMember] public required string Name { get; set; }
    [DataMember] public required string[] Tests { get; set; }
    [DataMember] public required string Instruction { get; set; }
    [DataMember] public required string Filter { get; set; }
    [DataMember] public int TimeLimit { get; set; }
    [DataMember] public int Reward { get; set; }

    public override string ToString()
    {
        return Name + "," + GameClassOrder + "," + TimeLimit + "," + Reward + "," + Filter + "=>" + Instruction.Substring(0, 30);
    }
}

[Route("api/[controller]")]
[Produces("application/json")]
public class GameController : ControllerBase
{
    private readonly ILogger<GameController> logger;
    private readonly DynamoDB dynamoDB;
    private readonly AwsBedrock awsBedrock;

    public GameController(ILogger<GameController> logger, DynamoDB dynamoDB, AwsBedrock awsBedrock)
    {
        this.logger = logger;
        this.dynamoDB = dynamoDB;
        this.awsBedrock = awsBedrock;
    }


    // GET: api/Game
    [HttpGet]
    public async Task<JsonResult> Get([FromQuery(Name = "api_key")] string apiKey, string mode)
    {
        logger.LogInformation("GameController.Get called");
        if (string.IsNullOrEmpty(apiKey))
        {
            return new JsonResult("Invalid request");
        }

        var user = await dynamoDB.GetUser(apiKey);
        if (user == null)
        {
            return new JsonResult("Invalid api key!");
        }

        if (new Random().NextDouble() < 0.5)
        {
            return new JsonResult(await awsBedrock.RandomNPCConversation());
        }

        var passedTests = await dynamoDB.GetPassedTestNames(user.Email);
        logger.LogInformation($"Passed tests: {string.Join(", ", passedTests)}");

        var tasks = GetTasksJson();
        var filteredTasks = tasks.Where(t => !t.Tests.All(passedTests.Contains));
        if (string.IsNullOrEmpty(mode))
        {
            return new JsonResult(filteredTasks);
        }
        var t = filteredTasks.Take(1).ToArray();
        if (new Random().NextDouble() < 0.7)
        {
            t[0].Instruction = await awsBedrock.RewriteInstruction(t[0].Instruction);
        }
        return new JsonResult(t);
    }

    private static IEnumerable<Type> GetTypesWithHelpAttribute(Assembly assembly)
    {
        return from Type type in assembly!.GetTypes()
               where type.GetCustomAttributes(typeof(GameClassAttribute), true).Length > 0
               select type;
    }

    public static IList<GameTaskData> GetTasksJson()
    {
        {
            var assembly = Assembly.GetAssembly(type: typeof(GameClassAttribute));
            var allTasks = new List<GameTaskData>();
            foreach (var testClass in GetTypesWithHelpAttribute(assembly!))
            {
                var gameClass = testClass.GetCustomAttribute<GameClassAttribute>();
                var tasks = testClass.GetMethods().Where(m => m.GetCustomAttribute<GameTaskAttribute>() != null)
                    .Select(c => new { c.Name, GameTask = c.GetCustomAttribute<GameTaskAttribute>()! });

                var independentTests = tasks.Where(c => c.GameTask.GroupNumber == -1)
                    .Select(c => new GameTaskData()
                    {
                        Name = testClass.FullName + "." + c.Name,
                        Tests = [testClass.FullName + "." + c.Name],
                        GameClassOrder = gameClass!.Order,
                        Instruction = c.GameTask.Instruction,
                        Filter = "test=" + testClass.FullName + "." + c.Name,
                        Reward = c.GameTask.Reward,
                        TimeLimit = c.GameTask.TimeLimit
                    });


                var groupedTasks = tasks.Where(c => c.GameTask.GroupNumber != -1)
                    .GroupBy(c => c.GameTask.GroupNumber)
                    .Select(c =>
                        new GameTaskData()
                        {
                            Name = string.Join(" ", c.Select(a => testClass.FullName + "." + a.Name)),
                            Tests = c.Select(a => testClass.FullName + "." + a.Name).ToArray(),
                            GameClassOrder = gameClass!.Order,
                            Instruction = string.Join("", c.Select(a => a.GameTask.Instruction)),
                            Filter =
                                string.Join("||", c.Select(a => "test==\"" + testClass.FullName + "." + a.Name + "\"")),
                            Reward = c.Sum(a => a.GameTask.Reward),
                            TimeLimit = c.Sum(a => a.GameTask.TimeLimit),
                        }
                    );

                allTasks.AddRange(independentTests);
                allTasks.AddRange(groupedTasks);
            }

            var allCompletedTask = allTasks.ToList();
            var serializerSettings = new JsonSerializerSettings
            {
                ContractResolver = new CamelCasePropertyNamesContractResolver()
            };
            allCompletedTask = allCompletedTask.OrderBy(c => c.GameClassOrder).ThenBy(c => c.Tests.First()).ToList();
            // var json = JsonConvert.SerializeObject(allCompletedTask.ToArray(), serializerSettings);                
            return allCompletedTask;
        }
    }
}
