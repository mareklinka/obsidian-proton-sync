import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingMock = vi.hoisted(() => vi.fn());
const getObsidianSettingsStoreMock = vi.hoisted(() => vi.fn());
const fileSinkWriteMock = vi.hoisted(() => vi.fn());
const getVaultLogSinkMock = vi.hoisted(() => vi.fn());

vi.mock('../services/ObsidianSettingsStore', () => ({
  getObsidianSettingsStore: getObsidianSettingsStoreMock
}));

vi.mock('../services/VaultLogSink', () => ({
  getVaultLogSink: getVaultLogSinkMock
}));

import { getLogger } from '../services/ConsoleLogger';

describe('ConsoleLogger', () => {
  let currentLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';
  let isFileLoggingEnabled = false;

  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockReset();
    getObsidianSettingsStoreMock.mockReset();
    getVaultLogSinkMock.mockReset();
    fileSinkWriteMock.mockReset();

    currentLevel = 'info';
    isFileLoggingEnabled = false;

    getSettingMock.mockImplementation((key: 'logLevel' | 'enableFileLogging') => {
      if (key === 'logLevel') {
        return currentLevel;
      }

      return isFileLoggingEnabled;
    });

    getObsidianSettingsStoreMock.mockReturnValue({
      get: getSettingMock
    });
    getVaultLogSinkMock.mockReturnValue({
      write: fileSinkWriteMock
    });
  });

  it('formats scoped messages and forwards extra payload', () => {
    currentLevel = 'debug';

    const logger = getLogger('sync').withScope('files');
    logger.info('Saved changes', { count: 2 });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('[ObsidianSync] [sync:files] Saved changes', { count: 2 });
  });

  it('filters logs by configured level severity', () => {
    currentLevel = 'warn';

    const logger = getLogger('scope');

    logger.debug('debug-msg');
    logger.log('log-msg');
    logger.info('info-msg');
    logger.warn('warn-msg');
    logger.error('error-msg');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[ObsidianSync] [scope] warn-msg');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[ObsidianSync] [scope] error-msg');
  });

  it('emits all methods when level is debug', () => {
    currentLevel = 'debug';

    const logger = getLogger('all');

    logger.debug('d', { d: true });
    logger.log('l', { l: true });
    logger.info('i', { i: true });
    logger.warn('w', { w: true });
    logger.error('e', { e: true });

    expect(debugSpy).toHaveBeenCalledWith('[ObsidianSync] [all] d', { d: true });
    expect(logSpy).toHaveBeenCalledWith('[ObsidianSync] [all] l', { l: true });
    expect(infoSpy).toHaveBeenCalledWith('[ObsidianSync] [all] i', { i: true });
    expect(warnSpy).toHaveBeenCalledWith('[ObsidianSync] [all] w', { w: true });
    expect(errorSpy).toHaveBeenCalledWith('[ObsidianSync] [all] e', { e: true });
  });

  it('suppresses all but error when level is error', () => {
    currentLevel = 'error';

    const logger = getLogger('strict');

    logger.debug('debug-msg');
    logger.log('log-msg');
    logger.info('info-msg');
    logger.warn('warn-msg');
    logger.error('error-msg');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[ObsidianSync] [strict] error-msg');
  });

  it('logs without scope decoration when scope is not provided', () => {
    currentLevel = 'debug';

    const logger = getLogger('');
    logger.log('Plain log');
    logger.withScope('child').info('Child info');

    expect(logSpy).toHaveBeenCalledWith('[ObsidianSync] Plain log');
    expect(infoSpy).toHaveBeenCalledWith('[ObsidianSync] [child] Child info');
  });

  it('falls back to info level when settings store access throws', () => {
    getObsidianSettingsStoreMock.mockImplementation(() => {
      throw new Error('Store not initialized');
    });

    const logger = getLogger('fallback');

    logger.debug('hidden-debug');
    logger.info('visible-info');
    logger.error('visible-error');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('[ObsidianSync] [fallback] visible-info');
    expect(errorSpy).toHaveBeenCalledWith('[ObsidianSync] [fallback] visible-error');
  });

  it('suppresses output when settings contain an invalid level value', () => {
    getSettingMock.mockReturnValue('fatal');

    const logger = getLogger('invalid-level');
    logger.error('should-not-log');

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes accepted entries to file sink when file logging is enabled', () => {
    currentLevel = 'info';
    isFileLoggingEnabled = true;

    const logger = getLogger('file-scope');
    logger.info('hello-file', { answer: 42 });

    expect(infoSpy).toHaveBeenCalledWith('[ObsidianSync] [file-scope] hello-file', { answer: 42 });
    expect(fileSinkWriteMock).toHaveBeenCalledWith('info', 'file-scope', 'hello-file', [{ answer: 42 }]);
  });
});
