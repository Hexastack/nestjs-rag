import { canonicalStringify, hashConfiguration, hashContent, hashIndexingInputs } from '../../src/utils/hash.util';
import { RagChunkingStrategy, RagRetrievalMode } from '../../src/enums';
import { RagProfileConfiguration } from '../../src/interfaces/profile.interface';

function config(overrides: Partial<RagProfileConfiguration> = {}): RagProfileConfiguration {
  return {
    name: 'default',
    retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
    chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 },
    ...overrides,
  };
}

describe('canonicalStringify / hashConfiguration', () => {
  it('produces identical hashes for objects that differ only in key order', () => {
    const a = { retrieval: { defaultMode: 'lexical' }, chunking: { chunkSize: 512, strategy: 'token' } };
    const b = { chunking: { strategy: 'token', chunkSize: 512 }, retrieval: { defaultMode: 'lexical' } };
    expect(canonicalStringify(a)).toEqual(canonicalStringify(b));
    expect(hashConfiguration(a)).toEqual(hashConfiguration(b));
  });

  it('produces different hashes when a value actually differs', () => {
    expect(hashConfiguration(config())).not.toEqual(hashConfiguration(config({ chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 800, chunkOverlap: 64 } })));
  });

  it('ignores undefined properties but not null/0/false', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toEqual(canonicalStringify({ a: 1 }));
    expect(canonicalStringify({ a: 0 })).not.toEqual(canonicalStringify({ a: undefined }));
    expect(canonicalStringify({ a: null })).not.toEqual(canonicalStringify({}));
  });

  it('is deterministic across repeated calls', () => {
    const c = config();
    expect(hashConfiguration(c)).toEqual(hashConfiguration(c));
  });
});

describe('hashContent', () => {
  it('is stable for identical content and changes when content changes', () => {
    expect(hashContent('hello world')).toEqual(hashContent('hello world'));
    expect(hashContent('hello world')).not.toEqual(hashContent('hello world!'));
  });
});

describe('hashIndexingInputs', () => {
  it('changes when the profile revision id changes, even with identical content', () => {
    const base = { contentHash: hashContent('abc'), profileRevisionId: 'rev-1' };
    const other = { ...base, profileRevisionId: 'rev-2' };
    expect(hashIndexingInputs(base)).not.toEqual(hashIndexingInputs(other));
  });

  it('changes when per-operation chunking overrides differ (documented direct-ingestion behavior)', () => {
    const base = { contentHash: hashContent('abc'), profileRevisionId: 'rev-1' };
    const withOverride = { ...base, chunkingOverrides: { chunkSize: 999 } };
    expect(hashIndexingInputs(base)).not.toEqual(hashIndexingInputs(withOverride));
  });

  it('is identical when all inputs are identical', () => {
    const inputs = { contentHash: hashContent('abc'), profileRevisionId: 'rev-1', chunkingOverrides: { chunkSize: 10 } };
    expect(hashIndexingInputs(inputs)).toEqual(hashIndexingInputs({ ...inputs }));
  });
});
