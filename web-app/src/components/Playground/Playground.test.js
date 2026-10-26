import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Playground from './Playground';

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn();
  jest.spyOn(window, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('does not request tasks without an API key', () => {
  render(<Playground />);
  expect(window.alert).toHaveBeenCalledWith('Please set the key first!');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('clears the loading spinner when grading fails', async () => {
  localStorage.setItem('api_key', 'example-key');
  global.fetch
    .mockResolvedValueOnce({ json: async () => [{ name: 'Task', filter: 'test=Task', instruction: 'Try it' }] })
    .mockRejectedValueOnce(new Error('Network unavailable'));
  render(<Playground />);
  fireEvent.click(screen.getByRole('button', { name: 'Select a Task' }));
  fireEvent.click(await screen.findByText('Task'));
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
});
