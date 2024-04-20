import React, { Component } from "react";
import Table from "react-bootstrap/Table";
import Button from "react-bootstrap/Button";
import Aws from "../../lib/Aws";

class Marks extends Component {
  constructor(props) {
    super(props);
    this.state = {
      testResult: [],
    };
  }
  componentDidMount() {
    const aws = new Aws();
    const urlWithQueryParams = aws.getApiUrl("marks");

    fetch(urlWithQueryParams)
      .then((response) => response.json())
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({ testResult: data }); // Save the data in the component's state
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
    const { testResult } = this.state;
    return (
      <div>
        <h2>Your Marks</h2>
        <Button variant="outline-primary" onClick={this.handleButtonClick}>
          Play "The Legend of AWS Warrior" Now!
        </Button>
        <Table striped bordered hover>
          <thead>
            <tr>
              <th>Test</th>
              <th>Mark</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {testResult.map((result, index) => (
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
