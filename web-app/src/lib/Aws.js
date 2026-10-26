import {baseUrl as basedUrl} from "../Constant";
class Aws {
  extractAWSCredentials = (rawKey) => {
    const credentials = {};
    for (const key of [
      "aws_access_key_id",
      "aws_secret_access_key",
      "aws_session_token",
    ]) {
      const match = rawKey.match(
        new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, "m")
      );
      if (!match) {
        throw new Error("Please paste complete AWS Academy Learner Lab credentials.");
      }
      credentials[key] = match[1];
    }
    return credentials;
  };

  getApiUrl = (controller) => {
    const urlWithQueryParams = new URL(basedUrl + controller);
    const api_key = localStorage.getItem("api_key");
    if (!api_key) {
      alert("Please set the key first!");
      return;
    }   
    return urlWithQueryParams;
  };
}

export default Aws;
