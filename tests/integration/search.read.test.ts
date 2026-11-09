/**
 * Module 6, advanced search (FR-17, FR-18; D-105): what is searched, how text is compared, the filters, one result per
 * element, the snippet, the errors, pagination, the tenants and the roles. Every 200 is checked against the contract.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertVariable,
  insertVariableCollection,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { insertCollectionField, keyOf, keysOf, search, searchOk, setColumns } from '../helpers/search.js';

describe('search: GET /search', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let appId: number;
  let otherAppId: number;
  const id: Record<string, number> = {};

  before(async () => {
    t = await startTestApp();
    try {
      appId = (await insertApplication(t, { name: 'Search app' })).id;
      const other = await insertApplication(t, { name: 'Other search app' });
      otherAppId = other.id;

      // Screens: the seven template fields, one token each.
      const home = await insertScreen(t, appId, { name: 'scrHome', documentationStatus: 'DRAFT' });
      id['home'] = home.id;
      await setColumns(t, 'screen', home.id, {
        on_start: 'tkOnStart',
        working_process: 'tkWorking',
        architecture: 'tkArch',
        data_model: 'tkData',
        requirements: 'tkReq',
        known_issues: 'tkIssues',
        risks: 'tkRisks',
      });
      id['config'] = (
        await insertScreen(t, appId, { name: 'Pantalla Configuración', documentationStatus: 'APPROVED' })
      ).id;
      id['multiScreen'] = (await insertScreen(t, appId, { name: 'scrMulti' })).id;
      await setColumns(t, 'screen', id['multiScreen'], { architecture: 'tkMulti later', on_start: 'tkMulti first' });

      // Variables.
      const gDesc = await insertVariable(t, appId, {
        name: 'gDesc',
        description: 'tkVarDesc',
        originScreenId: home.id,
        environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
      });
      id['gDesc'] = gDesc.id;
      id['cCtx'] = (await insertVariable(t, appId, { name: 'cCtx', scope: 'CONTEXT', originScreenId: home.id })).id;
      id['gNoSource'] = (
        await insertVariable(t, appId, { name: 'gNoSource', environments: [{ environment: 'PROD' }] })
      ).id;
      id['configVar'] = (await insertVariable(t, appId, { name: 'Configuración' })).id;
      id['configPlain'] = (await insertVariable(t, appId, { name: 'Configuracion' })).id;
      id['anio'] = (await insertVariable(t, appId, { name: 'añoFiscal' })).id;
      id['anoBase'] = (await insertVariable(t, appId, { name: 'anoBase' })).id;
      id['pct100'] = (await insertVariable(t, appId, { name: 'gPct', description: 'discount 100% off' })).id;
      id['pct1000'] = (await insertVariable(t, appId, { name: 'gPct2', description: 'discount 1000 off' })).id;
      id['under'] = (await insertVariable(t, appId, { name: 'gUnder', description: 'rate a_b applied' })).id;
      id['underX'] = (await insertVariable(t, appId, { name: 'gUnderX', description: 'rate axb applied' })).id;
      id['backslash'] = (await insertVariable(t, appId, { name: 'gBack', description: 'path c\\d here' })).id;
      id['meta'] = (
        await insertVariable(t, appId, {
          name: 'gMeta',
          description: 'call f(x) with [y] {z} a|b c+d e*f g?h i^j k$l m.n o-p p-q',
        })
      ).id;
      // The same words without the metacharacters: patterns such as f.x or [a-z] would match here if they were patterns.
      await insertVariable(t, appId, { name: 'gMetaDecoy', description: 'call fx with y z ab cd ef gh ij kl mxn op' });
      id['multiVar'] = (await insertVariable(t, appId, { name: 'tkMultiVar', description: 'tkMulti desc' })).id;
      id['usedVar'] = (await insertVariable(t, appId, { name: 'gUsed' })).id;
      id['assignVar'] = (await insertVariable(t, appId, { name: 'gAssign' })).id;

      // Collections.
      const colA = await insertCollection(t, appId, { name: 'colFields', environments: [{ environment: 'DEV' }] });
      id['colA'] = colA.id;
      await setColumns(t, 'collection', colA.id, { description: 'tkColDesc', creation_condition: 'tkCond' });
      await insertCollectionField(t, colA.id, 'tkFieldSecond', 2);
      await insertCollectionField(t, colA.id, 'tkFieldFirst', 1);
      id['colB'] = (await insertCollection(t, appId, { name: 'colB', environments: [{ environment: 'PROD' }] })).id;
      id['colUsed'] = (await insertCollection(t, appId, { name: 'colUsed' })).id;
      id['colAssign'] = (await insertCollection(t, appId, { name: 'colAssign' })).id;
      id['colBoth'] = (await insertCollection(t, appId, { name: 'colBoth' })).id;
      id['colTwo'] = (await insertCollection(t, appId, { name: 'colTwo' })).id;

      // Components.
      const btn = await insertComponent(t, appId, home.id, { name: 'btnSave', type: 'tkButtonType' });
      id['btn'] = btn.id;
      await setColumns(t, 'component', btn.id, { description: 'tkCmpDesc', on_select: 'tkOnSel' });

      // Links by usedIn.
      await insertScreenVariable(t, {
        screenId: home.id,
        variableId: id['usedVar'],
        accessMode: 'READ',
        usedIn: 'tkUsedVar',
      });
      await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: id['colUsed'],
        accessMode: 'READ',
        usedIn: 'tkUsedCol',
      });
      await insertVariableCollection(t, {
        variableId: id['assignVar'],
        collectionId: id['colAssign'],
        screenId: home.id,
        assignmentFunction: 'SET',
        usedIn: 'tkAssign',
      });
      // An element with both kinds of link whose text matches: the assignment has the LOWER id, the screen link wins.
      const assignBoth = await insertVariableCollection(t, {
        variableId: id['assignVar'],
        collectionId: id['colBoth'],
        screenId: home.id,
        assignmentFunction: 'SET',
        usedIn: 'tkBoth assignment',
      });
      for (const filler of ['one', 'two', 'three']) {
        await insertScreenCollection(t, {
          screenId: home.id,
          collectionId: id['colTwo'],
          accessMode: 'READ',
          usedIn: `filler ${filler}`,
        });
      }
      const screenBoth = await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: id['colBoth'],
        accessMode: 'READ',
        usedIn: 'tkBoth screen link',
      });
      assert.ok(assignBoth < screenBoth, 'the premise: the assignment has the lower id');
      // Two screen links: the lowest id wins.
      await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: id['colTwo'],
        accessMode: 'READ',
        usedIn: 'tkTwo first',
      });
      await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: id['colTwo'],
        accessMode: 'READ',
        usedIn: 'tkTwo second',
      });
      id['multiUsed'] = (await insertVariable(t, appId, { name: 'gMultiUsed' })).id;
      await insertScreenVariable(t, {
        screenId: home.id,
        variableId: id['multiUsed'],
        accessMode: 'READ',
        usedIn: 'tkMulti used',
      });

      // The other application holds the same texts: nothing of it may appear in A.
      const otherScreen = await insertScreen(t, otherAppId, { name: 'scrHome' });
      id['otherScreen'] = otherScreen.id;
      await setColumns(t, 'screen', otherScreen.id, { on_start: 'tkOnStart' });
      id['otherVar'] = (await insertVariable(t, otherAppId, { name: 'gDesc', description: 'tkVarDesc' })).id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const find = (q: string, extra: Record<string, string | number> = {}) =>
    searchOk(t, { applicationId: appId, q, ...extra });
  const only = async (q: string, extra: Record<string, string | number> = {}) => {
    const body = await find(q, extra);
    return body.data;
  };

  describe('what is searched', () => {
    it('SCREEN: the name and each of the seven template fields, as name and template', async () => {
      assert.deepEqual(
        (await only('scrHome')).map((r) => [r.type, r.matchedIn, r.snippet]),
        [['SCREEN', 'name', null]],
      );
      for (const token of ['tkOnStart', 'tkWorking', 'tkArch', 'tkData', 'tkReq', 'tkIssues', 'tkRisks']) {
        const found = await only(token);
        assert.deepEqual(
          keysOf({ data: found, page: 1, pageSize: 20, total: found.length }),
          [keyOf('SCREEN', id['home']!)],
          token,
        );
        assert.equal(found[0]!.matchedIn, 'template', token);
        assert.equal(found[0]!.snippet, token, token);
        assert.equal(found[0]!['documentationStatus'], 'DRAFT');
      }
    });

    it('VARIABLE: the name and the description', async () => {
      const byName = (await only('gNoSource'))[0]!;
      assert.deepEqual(
        [byName.type, byName.id, byName.matchedIn, byName.snippet],
        ['VARIABLE', id['gNoSource'], 'name', null],
      );
      assert.equal(byName['screen'], null, 'a variable without origin has screen null');
      assert.deepEqual(byName['environments'], ['PROD']);
      const byDescription = (await only('tkVarDesc'))[0]!;
      assert.deepEqual(
        [byDescription.id, byDescription.matchedIn, byDescription.snippet],
        [id['gDesc'], 'description', 'tkVarDesc'],
      );
      assert.deepEqual(byDescription['screen'], { id: id['home'], name: 'scrHome' });
      assert.deepEqual(byDescription['environments'], ['DEV', 'PROD']);
    });

    it('COLLECTION: the name, the description, the creation condition and the names of its fields', async () => {
      const expectations: [string, string][] = [
        ['colFields', 'name'],
        ['tkColDesc', 'description'],
        ['tkCond', 'creationCondition'],
        ['tkFieldSecond', 'fieldName'],
      ];
      for (const [q, matchedIn] of expectations) {
        const found = await only(q);
        assert.equal(found.length, 1, q);
        assert.deepEqual([found[0]!.type, found[0]!.id, found[0]!.matchedIn], ['COLLECTION', id['colA'], matchedIn], q);
        assert.deepEqual(found[0]!['environments'], ['DEV']);
        assert.equal(found[0]!.snippet, matchedIn === 'name' ? null : q);
      }
    });

    it('COMPONENT: the name, the description, onSelect and the control type, with its screen', async () => {
      for (const [q, matchedIn] of [
        ['btnSave', 'name'],
        ['tkCmpDesc', 'description'],
        ['tkOnSel', 'onSelect'],
        ['tkButtonType', 'type'],
      ] as const) {
        const found = await only(q);
        assert.equal(found.length, 1, q);
        assert.deepEqual([found[0]!.type, found[0]!.id, found[0]!.matchedIn], ['COMPONENT', id['btn'], matchedIn], q);
        assert.deepEqual(found[0]!['screen'], { id: id['home'], name: 'scrHome' });
        assert.equal(found[0]!.snippet, matchedIn === 'name' ? null : q);
      }
    });

    it('the fields that do not apply to a type are omitted, never null', async () => {
      const everything = await searchOk(t, { applicationId: appId, types: 'SCREEN,VARIABLE,COLLECTION,COMPONENT' });
      for (const r of everything.data) {
        assert.equal('documentationStatus' in r, r.type === 'SCREEN', `${r.type} documentationStatus`);
        assert.equal('environments' in r, r.type === 'VARIABLE' || r.type === 'COLLECTION', `${r.type} environments`);
        assert.equal('screen' in r, r.type === 'VARIABLE' || r.type === 'COMPONENT', `${r.type} screen`);
      }
    });

    it('the first template field in the order of the table gives the snippet', async () => {
      const found = await only('tkMulti');
      const screen = found.find((r) => r.type === 'SCREEN')!;
      assert.equal(screen.snippet, 'tkMulti first', 'on_start comes before architecture');
    });

    it('the first field of a collection by position gives the snippet', async () => {
      const found = await only('tkField');
      assert.equal(found.length, 1);
      assert.equal(found[0]!.snippet, 'tkFieldFirst', 'position 1 was inserted second but comes first');
    });
  });

  describe('usedIn', () => {
    it('a link of a screen returns the linked variable or collection, never the screen', async () => {
      const variable = await only('tkUsedVar');
      assert.deepEqual(
        variable.map((r) => [r.type, r.id, r.matchedIn, r.snippet]),
        [['VARIABLE', id['usedVar'], 'usedIn', 'tkUsedVar']],
      );
      const collection = await only('tkUsedCol');
      assert.deepEqual(
        collection.map((r) => [r.type, r.id, r.matchedIn, r.snippet]),
        [['COLLECTION', id['colUsed'], 'usedIn', 'tkUsedCol']],
      );
    });

    it('the reserved "origin" row is not searched', async () => {
      assert.deepEqual(await only('origin'), []);
    });

    it('an assignment of variable_collection returns the variable and the collection', async () => {
      const found = await only('tkAssign');
      assert.deepEqual(
        found.map((r) => [r.type, r.id, r.matchedIn, r.snippet]),
        [
          ['COLLECTION', id['colAssign'], 'usedIn', 'tkAssign'],
          ['VARIABLE', id['assignVar'], 'usedIn', 'tkAssign'],
        ],
      );
    });

    it('the link of a screen feeds the snippet before an assignment, even if the assignment has the lower id', async () => {
      const found = await only('tkBoth');
      const collection = found.filter((r) => r.type === 'COLLECTION');
      assert.equal(collection.length, 1);
      assert.equal(collection[0]!.id, id['colBoth']);
      assert.equal(collection[0]!.snippet, 'tkBoth screen link');
      // The variable of the assignment is found too, through the only link it has.
      const variable = found.filter((r) => r.type === 'VARIABLE');
      assert.deepEqual(
        variable.map((r) => [r.id, r.snippet]),
        [[id['assignVar'], 'tkBoth assignment']],
      );
    });

    it('among the links of a screen, the lowest id feeds the snippet', async () => {
      const found = await only('tkTwo');
      assert.equal(found.length, 1);
      assert.equal(found[0]!.snippet, 'tkTwo first');
    });
  });

  describe('one result per element', () => {
    it('an element that matches in several fields appears once, with the first field of the list', async () => {
      const name = (await only('tkMulti')).filter((r) => r.id === id['multiVar']);
      assert.deepEqual(
        name.map((r) => r.matchedIn),
        ['name'],
      );
      const description = await only('tkMulti d');
      assert.deepEqual(
        description.map((r) => [r.id, r.matchedIn]),
        [[id['multiVar'], 'description']],
      );
      const used = await only('tkMulti u');
      assert.deepEqual(
        used.map((r) => [r.id, r.matchedIn]),
        [[id['multiUsed'], 'usedIn']],
      );
    });

    it('nothing repeats in the whole list', async () => {
      const body = await searchOk(t, { applicationId: appId, q: 'tk', pageSize: 100 });
      assert.equal(new Set(keysOf(body)).size, body.data.length);
      assert.equal(body.total, body.data.length);
    });
  });

  describe('how text is compared', () => {
    it('ignores case and accents in both directions', async () => {
      const expected = [id['config'], id['configVar'], id['configPlain']].sort((a, b) => a! - b!);
      for (const q of ['configuracion', 'CONFIGURACIÓN', 'Configuración', 'configuración', 'CONFIGURACION']) {
        const found = await only(q);
        assert.deepEqual(
          found.map((r) => r.id).sort((a, b) => a - b),
          expected,
          q,
        );
      }
    });

    it('treats ñ as a different letter from n', async () => {
      assert.deepEqual(
        (await only('año')).map((r) => r.id),
        [id['anio']],
      );
      assert.deepEqual(
        (await only('AÑO')).map((r) => r.id),
        [id['anio']],
      );
      assert.deepEqual(
        (await only('ano')).map((r) => r.id),
        [id['anoBase']],
      );
    });

    it('takes every regular expression metacharacter as an ordinary character', async () => {
      for (const q of [
        'f(x)',
        '[y]',
        '{z}',
        'a|b',
        'c+d',
        'e*f',
        'g?h',
        'i^j',
        'k$l',
        'm.n',
        'o-p',
        'o-p p-q',
        '(x) with [y]',
      ]) {
        assert.deepEqual(
          (await only(q)).map((r) => r.id),
          [id['meta']],
          q,
        );
      }
      // As patterns these would match the decoy (and the rest); as text they match nothing.
      for (const q of ['.*', 'f.x', '[a-z]', 'a.b', 'x+', '(f|g)', '^$', '\\w+']) {
        assert.deepEqual(await only(q), [], q);
      }
    });

    it('takes % and _ as ordinary characters', async () => {
      assert.deepEqual(
        (await only('100%')).map((r) => r.id),
        [id['pct100']],
      );
      assert.deepEqual(
        (await only('a_b')).map((r) => r.id),
        [id['under']],
      );
      assert.deepEqual(
        (await only('c\\d')).map((r) => r.id),
        [id['backslash']],
      );
      assert.deepEqual(await only('%%'), []);
      assert.deepEqual(await only('__'), []);
    });

    it('finds the text anywhere in a field (substring)', async () => {
      assert.deepEqual((await only('Desc')).map((r) => r.id).includes(id['gDesc']!), true);
    });

    it('trims q: surrounding spaces do not matter', async () => {
      assert.deepEqual(
        (await only('  tkOnStart  ')).map((r) => r.id),
        [id['home']],
      );
    });
  });

  describe('errors', () => {
    it('q of fewer than 2 characters once trimmed is 400 minLength', async () => {
      for (const q of ['   ', ' a ', ' \t ']) {
        const res = await search(t, { applicationId: appId, q });
        assert.equal(res.status, 400, JSON.stringify(q));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.deepEqual(
          bodyOf(res).details.fields.map((f) => [f.field, f.rule]),
          [['q', 'minLength']],
          JSON.stringify(q),
        );
      }
      const one = await search(t, { applicationId: appId, q: 'a' });
      assert.equal(one.status, 400);
      assert.deepEqual(
        bodyOf(one).details.fields.map((f) => [f.field, f.rule]),
        [['q', 'minLength']],
      );
      const withFilter = await search(t, { applicationId: appId, q: ' a ', types: 'SCREEN' });
      assert.equal(withFilter.status, 400, 'a filter does not excuse a q that is too short');
    });

    it('an emoji counts as one character', async () => {
      const res = await search(t, { applicationId: appId, q: ' 😀 ' });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).details.fields[0]?.rule, 'minLength');
    });

    it('without q and without any filter is 400 required, as in the contract example', async () => {
      const res = await search(t, { applicationId: appId });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.equal(bodyOf(res).message, 'Check the highlighted fields.');
      assert.deepEqual(bodyOf(res).details.fields, [
        { field: 'q', rule: 'required', message: 'This value is required.' },
      ]);
    });

    it('applicationId is required', async () => {
      const res = await search(t, { q: 'tkOnStart' });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).details.fields[0]?.field, 'applicationId');
    });

    it('an application that does not exist, or outside the integer range, is 404', async () => {
      for (const applicationId of [999999, 2147483647, 2147483648, 99999999999]) {
        const res = await search(t, { applicationId, q: 'tkOnStart' });
        assert.equal(res.status, 404, String(applicationId));
        assert.equal(bodyOf(res).code, 'NOT_FOUND');
        assert.equal(bodyOf(res).details.element, 'application');
      }
    });

    it('400 comes before 404', async () => {
      assert.equal((await search(t, { applicationId: 999999 })).status, 400);
      assert.equal((await search(t, { applicationId: 999999, q: ' a ' })).status, 400);
      assert.equal((await search(t, { applicationId: 999999, types: 'SCREEN' })).status, 404);
    });

    it('rejects values outside the enumerations and a page size over 100', async () => {
      for (const extra of [
        { types: 'SCREEN,OTHER' },
        { environment: 'QA' },
        { documentationStatus: 'X' },
        { scope: 'Y' },
        { pageSize: 101 },
      ]) {
        assert.equal((await search(t, { applicationId: appId, q: 'tk', ...extra })).status, 400, JSON.stringify(extra));
      }
    });
  });

  describe('filters without text (matchedIn and snippet are null)', () => {
    const idsOf = (body: { data: { type: string; id: number }[] }, type: string): number[] =>
      body.data
        .filter((r) => r.type === type)
        .map((r) => r.id)
        .sort((a, b) => a - b);
    const all = async (extra: Record<string, string>) => searchOk(t, { applicationId: appId, pageSize: 100, ...extra });

    it('types alone lists the elements of those types, with null matchedIn and snippet', async () => {
      const body = await all({ types: 'COMPONENT' });
      assert.deepEqual(keysOf(body), [keyOf('COMPONENT', id['btn']!)]);
      assert.deepEqual([body.data[0]!.matchedIn, body.data[0]!.snippet], [null, null]);
    });

    it('environment restricts variables and collections, and leaves screens and components unfiltered', async () => {
      const body = await all({ environment: 'PROD' });
      assert.deepEqual(
        idsOf(body, 'VARIABLE'),
        [id['gDesc']!, id['gNoSource']!].sort((a, b) => a - b),
      );
      assert.deepEqual(idsOf(body, 'COLLECTION'), [id['colB']!]);
      const screens = await all({ types: 'SCREEN' });
      assert.deepEqual(idsOf(body, 'SCREEN'), idsOf(screens, 'SCREEN'));
      assert.deepEqual(idsOf(body, 'COMPONENT'), [id['btn']!]);
    });

    it('documentationStatus restricts screens only', async () => {
      const body = await all({ documentationStatus: 'APPROVED' });
      assert.deepEqual(idsOf(body, 'SCREEN'), [id['config']!]);
      const variables = await all({ types: 'VARIABLE' });
      assert.deepEqual(idsOf(body, 'VARIABLE'), idsOf(variables, 'VARIABLE'));
      assert.deepEqual(idsOf(body, 'COMPONENT'), [id['btn']!]);
    });

    it('scope restricts variables only', async () => {
      const body = await all({ scope: 'CONTEXT' });
      assert.deepEqual(idsOf(body, 'VARIABLE'), [id['cCtx']!]);
      assert.deepEqual(idsOf(body, 'COMPONENT'), [id['btn']!]);
      assert.ok(idsOf(body, 'SCREEN').length > 1 && idsOf(body, 'COLLECTION').length > 1);
    });

    it('a filter that applies to none of the selected types counts as a filter and restricts nothing', async () => {
      const filtered = await all({ types: 'COMPONENT', scope: 'CONTEXT' });
      assert.deepEqual(keysOf(filtered), [keyOf('COMPONENT', id['btn']!)]);
      const screens = await all({ types: 'SCREEN,COMPONENT', environment: 'PROD' });
      assert.ok(idsOf(screens, 'SCREEN').length >= 3);
      assert.equal(idsOf(screens, 'VARIABLE').length, 0);
    });

    it('types is applied first: the other filters do not bring back an excluded type', async () => {
      const body = await all({ types: 'VARIABLE', documentationStatus: 'APPROVED' });
      assert.ok(body.data.every((r) => r.type === 'VARIABLE'));
    });

    it('filters combine with the text', async () => {
      const body = await searchOk(t, {
        applicationId: appId,
        q: 'tk',
        types: 'VARIABLE',
        scope: 'GLOBAL',
        pageSize: 100,
      });
      assert.ok(body.data.length > 0 && body.data.every((r) => r.type === 'VARIABLE'));
    });
  });

  describe('pagination', () => {
    it('the pages add up to the whole list, in the same order, with a constant total', async () => {
      const whole = await searchOk(t, {
        applicationId: appId,
        types: 'SCREEN,VARIABLE,COLLECTION,COMPONENT',
        pageSize: 100,
      });
      assert.ok(whole.total > 7);
      const paged: string[] = [];
      for (let page = 1; page <= Math.ceil(whole.total / 3); page += 1) {
        const body = await searchOk(t, {
          applicationId: appId,
          types: 'SCREEN,VARIABLE,COLLECTION,COMPONENT',
          pageSize: 3,
          page,
        });
        assert.equal(body.total, whole.total);
        assert.equal(body.page, page);
        assert.equal(body.pageSize, 3);
        paged.push(...keysOf(body));
      }
      assert.deepEqual(paged, keysOf(whole));
    });

    it('a page beyond the end is empty, with the total', async () => {
      const body = await searchOk(t, { applicationId: appId, q: 'tkOnStart', page: 5 });
      assert.deepEqual([body.data, body.total, body.page], [[], 1, 5]);
    });

    it('defaults to page 1 and 20 per page', async () => {
      const body = await searchOk(t, { applicationId: appId, types: 'VARIABLE' });
      assert.deepEqual([body.page, body.pageSize], [1, 20]);
      assert.ok(body.data.length <= 20);
    });
  });

  describe('applications', () => {
    it('does not leak elements of another application, in either direction', async () => {
      const a = await only('tkOnStart');
      assert.deepEqual(
        a.map((r) => r.id),
        [id['home']],
      );
      const b = (await searchOk(t, { applicationId: otherAppId, q: 'tkOnStart' })).data;
      assert.deepEqual(
        b.map((r) => r.id),
        [id['otherScreen']],
      );
      const variablesB = (await searchOk(t, { applicationId: otherAppId, q: 'tkVarDesc' })).data;
      assert.deepEqual(
        variablesB.map((r) => r.id),
        [id['otherVar']],
      );
    });

    it('an archived application is searched normally', async () => {
      const archived = await insertApplication(t, { name: 'Archived search app' });
      const screen = await insertScreen(t, archived.id, { name: 'scrArchived' });
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      const body = await searchOk(t, { applicationId: archived.id, q: 'scrArchived' });
      assert.deepEqual(
        body.data.map((r) => r.id),
        [screen.id],
      );
    });
  });

  describe('roles, ETag and the driver', () => {
    it('the three roles can search; without a token or with an inactive user it is 401', async () => {
      for (const user of ['admin', 'developer', 'reader'] as const) {
        const body = await searchOk(t, { applicationId: appId, q: 'tkOnStart' }, t.users[user].token);
        assert.equal(body.total, 1, user);
      }
      const anonymous = await t.http.get(`/api/v1/search?applicationId=${appId}&q=tkOnStart`);
      assert.equal(anonymous.status, 401);
      assert.equal((await search(t, { applicationId: appId, q: 'tkOnStart' }, t.users.inactive.token)).status, 401);
    });

    it('sends an ETag and answers 304 to a matching If-None-Match, and 200 again when the data changes', async () => {
      const first = await search(t, { applicationId: appId, q: 'tkVarDesc' });
      const etag = first.headers['etag'] as string;
      assert.match(etag, /^W\//);
      const again = await search(t, { applicationId: appId, q: 'tkVarDesc' });
      assert.equal(again.headers['etag'], etag, 'the order is deterministic, so is the ETag');
      const cached = await t.http
        .get(`/api/v1/search?applicationId=${appId}&q=tkVarDesc`)
        .set('Authorization', `Bearer ${t.users.admin.token}`)
        .set('If-None-Match', etag);
      assert.equal(cached.status, 304);
      assert.deepEqual(cached.body, {});
      await setColumns(t, 'variable', id['gDesc']!, { description: 'tkVarDesc changed' });
      const changed = await search(t, { applicationId: appId, q: 'tkVarDesc' });
      assert.notEqual(changed.headers['etag'], etag);
      await setColumns(t, 'variable', id['gDesc']!, { description: 'tkVarDesc' });
    });

    it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(pgOverlap.stop(), []);
    });
  });
});
