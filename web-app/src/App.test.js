import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

beforeEach(() => {
  localStorage.clear();
});

test('renders the key setup page and navigation', () => {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>
  );
  expect(screen.getByRole('heading', { name: 'Set your key' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Marks' })).toHaveAttribute('href', '/marks');
});

test('renders the marks route without making requests when the key is missing', () => {
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});
  render(
    <MemoryRouter
      initialEntries={['/marks']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </MemoryRouter>
  );
  expect(screen.getByRole('heading', { name: 'Your Marks' })).toBeInTheDocument();
  expect(alert).toHaveBeenCalledWith('Please set the key first!');
  alert.mockRestore();
});
