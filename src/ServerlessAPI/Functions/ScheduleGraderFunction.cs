using System;
using Amazon.Lambda.Core;
using Amazon.Lambda.CloudWatchEvents;


namespace ServerlessAPI.Functions
{
    public class ScheduleGraderFunction
    {
        public void FunctionHandler(CloudWatchEvent<dynamic> cloudWatchEvent, ILambdaContext context)
        {
            context.Logger.LogLine($"[{DateTime.Now}] CloudWatch Event received: {cloudWatchEvent.Detail}");

            // Add your grading logic here
            GradeSchedule(cloudWatchEvent.Detail.ToString());
        }

        private void GradeSchedule(string message)
        {
            // Implement your schedule grading logic here
            // For example, parse the message and perform some operations
            Console.WriteLine($"Grading schedule: {message}");
        }
    }
}