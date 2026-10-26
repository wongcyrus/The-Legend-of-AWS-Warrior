import Aws from './Aws';
import { baseUrl } from '../Constant';

beforeEach(() => localStorage.clear());

test.each(['\n', '\r\n', '\r'])('parses credentials with %j line endings', (newline) => {
  const raw = [
    '[default]',
    'aws_access_key_id=example-access',
    'aws_secret_access_key=example-secret',
    'aws_session_token=example/token+value==',
    'region=us-east-1',
  ].join(newline);
  expect(new Aws().extractAWSCredentials(raw)).toEqual({
    aws_access_key_id: 'example-access',
    aws_secret_access_key: 'example-secret',
    aws_session_token: 'example/token+value==',
  });
});

test('accepts whitespace and reordered credential fields', () => {
  expect(new Aws().extractAWSCredentials(
    'aws_session_token = token==\n aws_secret_access_key = secret\naws_access_key_id = access\n'
  )).toEqual({
    aws_access_key_id: 'access',
    aws_secret_access_key: 'secret',
    aws_session_token: 'token==',
  });
});

test.each(['', '[default]', 'aws_access_key_id=access\naws_secret_access_key=secret',
  'aws_access_key_id=\naws_secret_access_key=secret\naws_session_token=token'])(
  'rejects incomplete credentials: %j', (raw) => {
    expect(() => new Aws().extractAWSCredentials(raw)).toThrow(/complete.*credentials/i);
  }
);

test('returns the controller URL when a key is stored', () => {
  localStorage.setItem('api_key', 'example-key');
  expect(new Aws().getApiUrl('game').href).toBe(`${baseUrl}game`);
});

test('prompts for a missing key without returning a URL', () => {
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});
  expect(new Aws().getApiUrl('game')).toBeUndefined();
  expect(alert).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});
