import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRegionConfig, REGIONS } from '../src/constants.js';

test('getRegionConfig(EU) builds the European Okta + GraphQL endpoints', () => {
  const r = getRegionConfig('EU');
  assert.equal(r.authnUrl, 'https://id.resmed.eu/api/v1/authn');
  assert.equal(r.authorizeUrl, 'https://id.resmed.eu/oauth2/aus2uznux2sYKTsEg417/v1/authorize');
  assert.equal(r.tokenUrl, 'https://id.resmed.eu/oauth2/aus2uznux2sYKTsEg417/v1/token');
  assert.equal(r.graphqlUrl, 'https://graphql.hyperdrive.resmed.eu/graphql');
  assert.equal(r.product, 'myAir EU');
});

test('getRegionConfig(NA) builds the North American endpoints', () => {
  const r = getRegionConfig('NA');
  assert.equal(r.authnUrl, 'https://resmed-ext-1.okta.com/api/v1/authn');
  assert.equal(r.graphqlUrl, 'https://graphql.myair-prd.dht.live/graphql');
  assert.equal(r.product, 'myAir');
});

test('mfaUrl uses the given factor id and remembers the device', () => {
  const r = getRegionConfig('EU');
  assert.equal(
    r.mfaUrl('factor123'),
    'https://id.resmed.eu/api/v1/authn/factors/factor123/verify?rememberDevice=true',
  );
  // Falls back to the region default factor id when none is given.
  assert.equal(
    r.mfaUrl(),
    `https://id.resmed.eu/api/v1/authn/factors/${REGIONS.EU.emailFactorId}/verify?rememberDevice=true`,
  );
});

test('getRegionConfig throws on an unknown region', () => {
  assert.throws(() => getRegionConfig('ASIA'), /Unsupported myAir region/);
});
