import { render, screen } from '@testing-library/react';
import Marks from './Marks';

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('api_key', 'example-key');
  global.fetch = jest.fn();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
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
