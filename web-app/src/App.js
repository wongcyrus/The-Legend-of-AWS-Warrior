import React from "react";
import "./App.css";
import { Route, Routes } from "react-router-dom";
import Playground from "./components/Playground/Playground";
import Home from "./components/Home/Home";
import Marks from "./components/Marks/Marks";

import Container from "react-bootstrap/Container";
import Nav from "react-bootstrap/Nav";
import Navbar from "react-bootstrap/Navbar";

function App() {
  return (
    <Container>
      <Navbar expand="lg" className="bg-body-tertiary">
        <Navbar.Brand href="#home">AWS Project Grader</Navbar.Brand>
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        <Navbar.Collapse id="basic-navbar-nav">
          <Nav className="me-auto">
            <Nav.Link href="/">Set Key</Nav.Link>
            {/* <Nav.Link href="/playground">Playground</Nav.Link> */}
            <Nav.Link href="/marks">Marks</Nav.Link>
          </Nav>
        </Navbar.Collapse>
      </Navbar>
      <Routes>
        <Route path="/" element={<Home/>} />
        {/* <Route path="/playground" element={<Playground/>} /> */}
        <Route path="/marks" element={<Marks/>} />
      </Routes>
    </Container>
  );
}

export default App;
