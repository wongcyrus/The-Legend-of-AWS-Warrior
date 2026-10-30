import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Marks from './Marks';

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('api_key', 'example-key');
  global.fetch = jest.fn();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function respond(passed, failed) {
  global.fetch
    .mockResolvedValueOnce({ ok: true, json: async () => passed })
    .mockResolvedValueOnce({ ok: true, json: async () => failed });
}

test('renders passed marks and the last failed test', async () => {
  respond([{ test: 'PassingTest', mark: 10, time: '2026-01-01' }],
    { test: 'FailingTest', time: '2026-01-02', logUrl: 'https://example.com/log' });
  render(<Marks />);
  expect(await screen.findByText('PassingTest')).toBeInTheDocument();
  expect(await screen.findByRole('link', { name: 'Test Log' })).toHaveAttribute('href', 'https://example.com/log');
  expect(screen.getByText('10')).toBeInTheDocument();
});

test.each([[], null])('does not show a failed test for the empty response %j', async (failed) => {
  respond([{ test: 'PassingTest', mark: 10, time: '' }], failed);
  render(<Marks />);
  await screen.findByText('PassingTest');
  expect(screen.queryByRole('heading', { name: 'The Last Failed Test' })).not.toBeInTheDocument();
});

test('reports malformed marks without crashing the table', async () => {
  respond('Invalid API key', []);
  render(<Marks />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load marks.');
});

test('reports an HTTP failure', async () => {
  global.fetch
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  render(<Marks />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load marks.');
});

test('keeps Classic as the default and offers a separate enhanced beta', async () => {
  respond([{ test: 'PassingTest', mark: 10, time: '' }], []);
  const open = jest.spyOn(window, 'open').mockImplementation(() => {});
  render(<Marks />);
  await screen.findByText('PassingTest');
  fireEvent.click(screen.getByRole('button', { name: 'Play Classic' }));
  expect(open).toHaveBeenCalledWith('game.html', '_blank');
  const beta = screen.getByRole('link', { name: 'Play AWS Warrior V2' });
  expect(beta).toHaveAttribute('href', 'game-v2.html');
  expect(beta).toHaveAttribute('target', '_blank');
  expect(beta).toHaveAttribute('rel', 'noopener noreferrer');
});

async function loadMarks() {
  respond([{ test: 'PassingTest', mark: 10, time: '' }],
    { test: 'FailingTest', time: '', logUrl: 'https://example.com/log' });
  render(<Marks />);
  await screen.findByText('PassingTest');
  const button = screen.getByRole('button', { name: 'Reset my marks' });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

function mockResetDigest(implementation) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
  const encoder = global.TextEncoder;
  global.TextEncoder = require('util').TextEncoder;
  Object.defineProperty(window, 'crypto', { configurable: true, value: { subtle: { digest: jest.fn(implementation) } } });
  return () => {
    if (descriptor) Object.defineProperty(window, 'crypto', descriptor);
    else delete window.crypto;
    global.TextEncoder = encoder;
  };
}

test('successful reset scopes adventure invalidation to the API key hash, never the key itself', async () => {
  const button = await loadMarks();
  const restore = mockResetDigest(async () => new Uint8Array(32).fill(0xab).buffer);
  try {
    window.confirm.mockReturnValue(true);
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isSuccess: true }) });
    fireEvent.click(button);
    await screen.findByRole('status');
    const marker = localStorage.getItem('aws-warrior:marks-reset');
    expect(JSON.parse(marker)).toEqual({ owner: 'ab'.repeat(32), stamp: expect.any(String) });
    expect(marker).not.toContain('example-key');
  } finally { restore(); }
});

test('reset preserves the newly selected account when the key changes during owner hashing', async () => {
  const button = await loadMarks();
  let finish;
  const restore = mockResetDigest(() => new Promise(resolve => { finish = resolve; }));
  try {
    window.confirm.mockReturnValue(true);
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isSuccess: true }) });
    fireEvent.click(button);
    await waitFor(() => expect(finish).toBeDefined());
    localStorage.setItem('api_key', 'new-example-key');
    localStorage.setItem('filter', 'new-account-task');
    finish(new Uint8Array(32).buffer);
    await screen.findByRole('alert');
    expect(localStorage.getItem('filter')).toBe('new-account-task');
    expect(localStorage.getItem('aws-warrior:marks-reset')).toBeNull();
    expect(screen.getByText('PassingTest')).toBeInTheDocument();
  } finally { restore(); }
});

test('reset still succeeds if Web Crypto is unavailable', async () => {
  const button = await loadMarks();
  const restore = mockResetDigest(async () => { throw new Error('Unavailable'); });
  try {
    window.confirm.mockReturnValue(true);
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isSuccess: true }) });
    fireEvent.click(button);
    await screen.findByRole('status');
    expect(localStorage.getItem('aws-warrior:marks-reset')).toMatch(/^\d+$/);
  } finally { restore(); }
});

test('refresh reloads both result endpoints with the API key without resetting progress', async () => {
  await loadMarks();
  localStorage.setItem('filter', 'classic-quest');
  sessionStorage.setItem('aws-warrior:v2:quest', 'saved-quest');
  respond([{ test: 'NewPassingTest', mark: 20, time: '2026-10-27' }], []);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh marks' }));
  expect(await screen.findByText('NewPassingTest')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh marks' })).toBeEnabled());
  expect(screen.queryByText('PassingTest')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'The Last Failed Test' })).not.toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(4);
  expect(global.fetch.mock.calls.slice(2).map(([url]) => url.pathname)).toEqual([
    '/Prod/getpassedtest', '/Prod/getthelastfailedtest',
  ]);
  for (const [, options] of global.fetch.mock.calls.slice(2)) {
    expect(options).toEqual({ headers: { 'x-api-key': 'example-key' } });
  }
  expect(window.confirm).not.toHaveBeenCalled();
  expect(localStorage.getItem('api_key')).toBe('example-key');
  expect(localStorage.getItem('filter')).toBe('classic-quest');
  expect(sessionStorage.getItem('aws-warrior:v2:quest')).toBe('saved-quest');
});

test('refresh and reset stay disabled until both refresh requests finish', async () => {
  await loadMarks();
  let finishPassed, finishFailed;
  global.fetch
    .mockImplementationOnce(() => new Promise(resolve => { finishPassed = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishFailed = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh marks' }));
  const refreshing = screen.getByRole('button', { name: 'Loading marks...' });
  expect(refreshing).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reset my marks' })).toBeDisabled();
  fireEvent.click(refreshing);
  expect(global.fetch).toHaveBeenCalledTimes(4);
  finishPassed({ ok: true, json: async () => [{ test: 'RefreshedTest', mark: 10, time: '' }] });
  await screen.findByText('RefreshedTest');
  expect(refreshing).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reset my marks' })).toBeDisabled();
  finishFailed({ ok: true, json: async () => [] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh marks' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Reset my marks' })).toBeEnabled();
});

test('refresh recovers from an earlier loading error', async () => {
  global.fetch
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  render(<Marks />);
  await screen.findByRole('alert');
  const refresh = await screen.findByRole('button', { name: 'Refresh marks' });
  respond([{ test: 'RecoveredTest', mark: 10, time: '' }], []);
  fireEvent.click(refresh);
  await screen.findByText('RecoveredTest');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('failed refresh retains the displayed results and permits retry', async () => {
  await loadMarks();
  global.fetch
    .mockRejectedValueOnce(new Error('Offline'))
    .mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh marks' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh marks' })).toBeEnabled());
  expect(screen.getByText('PassingTest')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'The Last Failed Test' })).toBeInTheDocument();
});

test('confirmed reset posts only the API key and clears marks and quest state, not credentials', async () => {
  const button = await loadMarks();
  localStorage.setItem('credentials', 'saved-credentials');
  localStorage.setItem('filter', 'classic-quest');
  localStorage.setItem('aws-warrior:v2:quality', 'low');
  sessionStorage.setItem('aws-warrior:v2:quest', 'saved-quest');
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ isSuccess: true }) });
  fireEvent.click(button);
  expect(await screen.findByRole('status')).toHaveTextContent('marks and failed-test history have been reset');
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Permanently reset'));
  const [url, options] = global.fetch.mock.calls[2];
  expect(url.pathname).toBe('/Prod/resetmarks');
  expect(url.search).toBe('');
  expect(options).toEqual({ method: 'POST', headers: { 'x-api-key': 'example-key' } });
  expect(screen.queryByText('PassingTest')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'The Last Failed Test' })).not.toBeInTheDocument();
  expect(localStorage.getItem('api_key')).toBe('example-key');
  expect(localStorage.getItem('credentials')).toBe('saved-credentials');
  expect(localStorage.getItem('aws-warrior:v2:quality')).toBe('low');
  expect(localStorage.getItem('filter')).toBeNull();
  expect(sessionStorage.getItem('aws-warrior:v2:quest')).toBeNull();
  expect(localStorage.getItem('aws-warrior:marks-reset')).not.toBeNull();
});

test('cancelling reset never sends a deletion request', async () => {
  const button = await loadMarks();
  window.confirm.mockReturnValue(false);
  fireEvent.click(button);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText('PassingTest')).toBeInTheDocument();
});

test.each([
  { ok: false },
  { ok: true, json: async () => ({ isSuccess: false }) },
  { ok: true, json: async () => 'Options request' },
  { ok: true, json: async () => { throw new Error('Invalid JSON'); } },
])('failed reset preserves displayed marks and browser quest state: %j', async result => {
  const button = await loadMarks();
  localStorage.setItem('filter', 'classic-quest');
  sessionStorage.setItem('aws-warrior:v2:quest', 'saved-quest');
  global.fetch.mockResolvedValueOnce(result);
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to finish resetting marks');
  expect(screen.getByText('PassingTest')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'The Last Failed Test' })).toBeInTheDocument();
  expect(localStorage.getItem('filter')).toBe('classic-quest');
  expect(sessionStorage.getItem('aws-warrior:v2:quest')).toBe('saved-quest');
  expect(localStorage.getItem('aws-warrior:marks-reset')).toBeNull();
  expect(button).toBeEnabled();
});

test('only one reset request runs at a time', async () => {
  const button = await loadMarks();
  let finish;
  global.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(button);
  fireEvent.click(button);
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: 'Resetting marks...' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Refresh marks' })).toBeDisabled();
  finish({ ok: true, json: async () => ({ isSuccess: true }) });
  await screen.findByRole('status');
});

test('a response for a previous API key cannot clear the current browser account state', async () => {
  const button = await loadMarks();
  let finish;
  global.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(button);
  localStorage.setItem('api_key', 'another-key');
  localStorage.setItem('filter', 'another-quest');
  finish({ ok: true, json: async () => ({ isSuccess: true }) });
  await screen.findByRole('alert');
  expect(localStorage.getItem('api_key')).toBe('another-key');
  expect(localStorage.getItem('filter')).toBe('another-quest');
  expect(localStorage.getItem('aws-warrior:marks-reset')).toBeNull();
  expect(screen.getByText('PassingTest')).toBeInTheDocument();
});

test('reset stays disabled until initial marks requests finish', async () => {
  global.fetch.mockImplementation(() => new Promise(() => {}));
  render(<Marks />);
  expect(screen.getByRole('button', { name: 'Reset my marks' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Loading marks...' })).toBeDisabled();
  expect(window.confirm).not.toHaveBeenCalled();
});
