import {describe, expect, mock, test} from 'bun:test';
import dayjs from 'dayjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TweetLegacyFromJSON, UserFromJSON} from 'twitter-openapi-typescript-generated';

// Offline regression tests: importing a fetch script must never authenticate or write logs.
mock.module('../utils/logger', () => ({cleanupLogger: async () => true}));
mock.module('../scripts/utils', () => ({
    XAuthClient: async () => { throw new Error('Network access is disabled in tests'); }
}));
const {processTweets} = await import('../scripts/fetch-home-latest-timeline');
const {simplifyUser} = await import('../scripts/fetch-following');

const threshold = dayjs('2026-09-29T00:00:00+08:00');
const filters = {filterRetweets: true, filterQuotes: true};
const following = new Set(['42']);

// Decode wire-format fixtures with the project's installed SDK, as the real API client does.
function fixture(schema: 'core' | 'legacy' = 'core', tweetOverrides: Record<string, unknown> = {}) {
    const identity = {screen_name: 'sample_user', name: 'Sample User', created_at: '2020-01-01T00:00:00Z'};
    return {
        user: UserFromJSON({
            __typename: 'User', id: 'User:42', rest_id: '42', is_blue_verified: false,
            profile_image_shape: 'Circle',
            legacy: schema === 'legacy' ? identity : {},
            ...(schema === 'core' ? {core: identity} : {})
        }),
        tweet: {legacy: TweetLegacyFromJSON({
            id_str: '12345', user_id_str: '42', created_at: '2026-09-30T00:00:00Z',
            full_text: 'Hello world', is_quote_status: false,
            entities: {urls: [{expanded_url: 'https://example.com/article'}]},
            extended_entities: {media: [{type: 'photo', media_url_https: 'https://example.com/photo.jpg'}]},
            ...tweetOverrides
        })}
    };
}

describe('home timeline schema compatibility', () => {
    test.each(['core', 'legacy'] as const)('processes %s user identity and preserves saved fields', schema => {
        const result = processTweets([fixture(schema)], following, threshold, filters);
        expect(result.validTweets).toEqual([{
            user: {screenName: 'sample_user', name: 'Sample User'},
            images: ['https://example.com/photo.jpg'], videos: [],
            expandUrls: ['https://example.com/article'],
            tweetUrl: 'https://x.com/sample_user/status/12345', fullText: 'Hello world',
            publishTime: '2026-09-30T08:00:00', userIdStr: '42', isRetweet: false, isQuote: false
        }]);
    });

    test('fails with field counts if every item is malformed', () => {
        const malformed = fixture('legacy');
        malformed.user.legacy.screenName = undefined;
        expect(() => processTweets([malformed, malformed], following, threshold, filters))
            .toThrow(/screenName=2/);
    });

    test('does not invent missing tweet IDs or accept invalid timestamps', () => {
        expect(() => processTweets([fixture('core', {id_str: undefined})], following, threshold, filters))
            .toThrow(/tweetId=1/);
        expect(() => processTweets([fixture('core', {created_at: 'invalid'})], following, threshold, filters))
            .toThrow(/invalidCreatedAt=1/);
    });

    test.each(['core', 'legacy'] as const)('keeps following output compatible for %s users', schema => {
        const user = fixture(schema).user;
        const result = simplifyUser(user);
        expect(result.restId).toBe('42');
        expect(result.legacy).toMatchObject({
            screenName: 'sample_user', name: 'Sample User', createdAt: '2020-01-01T00:00:00Z'
        });
        expect(result).not.toHaveProperty('core');
    });

    test('uses current identity when both SDK field locations are populated', () => {
        const item = fixture('core');
        item.user.legacy.screenName = 'old_name';
        item.user.legacy.name = 'Old Name';
        expect(processTweets([item], following, threshold, filters).validTweets[0]?.user)
            .toEqual({screenName: 'sample_user', name: 'Sample User'});
    });

    test('normal empty and fully filtered batches are successful', () => {
        expect(processTweets([], following, threshold, filters).validTweets).toEqual([]);
        const result = processTweets([
            fixture('legacy', {full_text: 'RT @someone: shared'}),
            fixture('legacy', {is_quote_status: true}),
            fixture('legacy', {user_id_str: '99'}),
            fixture('legacy', {created_at: '2026-09-01T00:00:00Z'})
        ], following, threshold, filters);
        expect(result.validTweets).toEqual([]);
        expect(result.counter).toMatchObject({retweets: 1, quotes: 1, nonFollowing: 1, outOfRange: 1});
    });

    test('a malformed item does not discard other valid tweets', () => {
        const result = processTweets([{}, fixture('legacy')], following, threshold, filters);
        expect(result.validTweets).toHaveLength(1);
    });

    test('filter switches still permit retweets and quotes', () => {
        const result = processTweets([
            fixture('legacy', {full_text: 'RT @someone: shared'}),
            fixture('legacy', {is_quote_status: true})
        ], following, threshold, {filterRetweets: false, filterQuotes: false});
        expect(result.validTweets).toHaveLength(2);
    });

    test('the CLI exits with failure when an entire fetched batch cannot be parsed', () => {
        const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
        // Run the actual main/controller in a subprocess with mocked auth and filesystem.
        // It must fail before saving output, without using credentials or any network request.
        const script = `
            import {mock} from 'bun:test';
            mock.module(${modulePath('../utils/logger.ts')}, () => ({cleanupLogger: async () => true}));
            mock.module('fs-extra', () => ({default: {
                readJSON: async () => [], existsSync: () => false, mkdirSync: () => {},
                promises: {writeFile: async () => {}}
            }}));
            mock.module(${modulePath('../scripts/utils.ts')}, () => ({XAuthClient: async () => ({
                getTweetApi: () => ({getHomeLatestTimeline: async () => ({data: {data: [{
                    user: {}, tweet: {legacy: {
                        userIdStr: '42', idStr: '12345', createdAt: new Date().toISOString()
                    }}
                }]}})})
            })}));
            const {main} = await import(${modulePath('../scripts/fetch-home-latest-timeline.ts')});
            await main();
        `;
        const result = spawnSync(process.execPath, ['--eval', script], {encoding: 'utf8', timeout: 10000});
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('screenName=1');
        expect(result.stdout).not.toContain('开始数据存储');
    });
});
