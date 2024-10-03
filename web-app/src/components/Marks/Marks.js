import React, { Component } from "react";
import Table from "react-bootstrap/Table";
import Button from "react-bootstrap/Button";
import Aws from "../../lib/Aws";

class Marks extends Component {
  constructor(props) {
    super(props);
    this.state = {
      testResults: [],
      theLastFailedTest: null,
    };
  }
  componentDidMount() {
    const aws = new Aws();
    const urlWithQueryParams = aws.getApiUrl("getpassedtest");

    fetch(urlWithQueryParams)
      .then((response) => response.json())
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({ testResults: data }); // Save the data in the component's state
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
      });

    const urlWithQueryParams2 = aws.getApiUrl("getthelastfailedtest");

    fetch(urlWithQueryParams2)
      .then((response) => response.json())
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({ theLastFailedTest: data }); // Save the data in the component's state
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
      });
  }

  handleButtonClick = (event) => {
    event.preventDefault();
    window.open("game.html", "_blank");
  };

  render() {
    const { testResults, theLastFailedTest } = this.state;
    return (
      <div>
        <h2>Your Marks</h2>
        <Button variant="outline-primary" onClick={this.handleButtonClick}>
          Play "The Legend of AWS Warrior" Now!
        </Button>
        {theLastFailedTest && (
          <>
            <h3>The Last Failed Test</h3>
            <p>
              Name: {theLastFailedTest.test} ({theLastFailedTest.time})
            </p>
            <p>
              <a href={theLastFailedTest.logUrl} target="_blank" rel="noreferrer">
                Test Log
              </a>
            </p>
          </>
        )}
        <h3>The Passed Test</h3>
        <Table striped bordered hover>
          <thead>
            <tr>
              <th>Test</th>
              <th>Mark</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {testResults.map((result, index) => (
              <tr key={index}>
                <td>{result.test}</td>
                <td>{result.mark}</td>
                <td>{result.time}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  }
}

export default Marks;
