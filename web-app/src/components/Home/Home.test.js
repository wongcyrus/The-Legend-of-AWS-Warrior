import { fireEvent, render, screen } from '@testing-library/react';
import Home from './Home';

const credentials = 'aws_access_key_id=access\naws_secret_access_key=secret\naws_session_token=token==';
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

test('restores saved values and resets storage and fields', () => {
  localStorage.setItem('api_key', 'example-key');
  localStorage.setItem('credentials', credentials);
  render(<Home />);
  expect(screen.getByPlaceholderText('API Key')).toHaveValue('example-key');
  expect(screen.getByRole('textbox', { name: /AWS credentials/ })).toHaveValue(credentials);
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByPlaceholderText('API Key')).toHaveValue('');
  expect(localStorage.getItem('api_key')).toBeNull();
  expect(localStorage.getItem('credentials')).toBeNull();
});

test.each([
  [null, null, /paste your AWS/],
  [null, credentials, /set the key/],
  ['example-key', 'incomplete', /complete.*credentials/],
])('does not submit missing or invalid input', (key, raw, message) => {
  if (key) localStorage.setItem('api_key', key);
  if (raw) localStorage.setItem('credentials', raw);
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: /Save AWS Account credentials/ }));
  expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(message));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('submits parsed credentials and displays the account status', async () => {
  localStorage.setItem('api_key', 'example-key');
  localStorage.setItem('credentials', credentials);
  global.fetch.mockResolvedValue({ ok: true, json: async () => 'Account registered' });
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: /Save AWS Account credentials/ }));
  expect(await screen.findByText('Account registered')).toBeInTheDocument();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url.searchParams.get('aws_access_key')).toBe('access');
  expect(url.searchParams.get('aws_secret_access_key')).toBe('secret');
  expect(url.searchParams.get('aws_session_token')).toBe('token==');
  expect(options.headers['x-api-key']).toBe('example-key');
});

test('shows a failure instead of treating an HTTP error as success', async () => {
  localStorage.setItem('api_key', 'example-key');
  localStorage.setItem('credentials', credentials);
  global.fetch.mockResolvedValue({ ok: false });
  render(<Home />);
  fireEvent.click(screen.getByRole('button', { name: /Save AWS Account credentials/ }));
  expect(await screen.findByText(/Unable to save AWS account/)).toBeInTheDocument();
});
