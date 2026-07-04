import assert from 'assert';
import { writeFileSync } from 'fs';
import autocannon from 'autocannon';
import {
    after, before, describe, it,
} from 'node:test';
import * as supertest from 'supertest';

const Root = {
    username: 'root',
    password: '123456',
    creditionals: null,
};

const RootProfile = {
    realName: 'Root User',
    birthYear: '2010',
    birthMonth: '5',
    school: 'Root School',
    grade: 'junior1',
};

const PhoneUserProfile = {
    realName: 'Phone User',
    birthYear: '2011',
    birthMonth: '6',
    school: 'Phone School',
    grade: 'junior2',
};

describe('App', () => {
    let agent;
    before(async () => {
        const init = Date.now();
        await new Promise<void>((resolve) => {
            let resolved = false;
            const finish = (data: any) => {
                if (resolved) return;
                console.log('send', data);
                const { httpServer } = require('@hydrooj/framework');
                agent = supertest.agent(httpServer);
                resolved = true;
                resolve();
            };
            process.send = ((send) => (data) => {
                if (data === 'ready') finish(data);
                return send?.(data) || false;
            })(process.send);
        });
        console.log('Application inited in %d ms', Date.now() - init);
    }, { timeout: 30000 });

    const routes = ['/', '/p', '/contest', '/homework', '/user/1', '/training'];
    for (const route of routes) {
        // eslint-disable-next-line ts/no-loop-func
        it(`GET ${route}`, () => agent.get(route).expect(200));
    }

    it('API user', async () => {
        await agent.get('/api/user?args={"id":1}&projection=uname').expect({ uname: 'Hydro' });
        await agent.get('/api/user?args={"id":2}&projection=uname').expect(null);
    });

    it('Register page keeps email registration without SMTP or SMS', async () => {
        const enabled = process.env.HYDRO_SMS_ALIYUN_ENABLED;
        delete process.env.HYDRO_SMS_ALIYUN_ENABLED;
        try {
            const res = await agent.get('/register').expect(200);
            assert.match(res.text, /name="mail"/);
            assert.doesNotMatch(res.text, /name="phone"/);
        } finally {
            if (enabled === undefined) delete process.env.HYDRO_SMS_ALIYUN_ENABLED;
            else process.env.HYDRO_SMS_ALIYUN_ENABLED = enabled;
        }
    });

    it('Create User', async () => {
        const redirect = await agent.post('/register')
            .send({ mail: 'test@example.com' })
            .expect(302)
            .then((res) => res.headers.location);
        await agent.post(redirect)
            .send({ uname: Root.username, password: Root.password, verifyPassword: Root.password })
            .expect(302);
    });

    it('Login', async () => {
        const res = await agent.post('/login')
            .send({ uname: Root.username, password: Root.password })
            .expect(302);
        assert.match(res.headers.location, /^\/home\/phone\?/);
        Root.creditionals = res.headers['set-cookie'];
    });

    it('API registered user', async () => {
        await agent.get('/api/user?args={"id":2}&projection=uname').expect({ uname: 'root' });
    });

    it('Phone binding for existing users records private real name', async () => {
        const phone = '13900139000';
        const sendRes = await agent.post('/home/phone')
            .send({ phone, ...RootProfile })
            .expect(200);
        assert.match(sendRes.text, /name="smsCode"/);
        await agent.post('/home/phone')
            .send({
                phone, ...RootProfile, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
            })
            .expect(302);
        const UserModel = require('../packages/hydrooj/src/model/user').default;
        const udoc = await UserModel.getByUname('system', Root.username);
        assert.equal(udoc.phone, phone);
        assert.equal(udoc.realName, RootProfile.realName);
        assert.equal(udoc.birthYear, RootProfile.birthYear);
        assert.equal(udoc.birthMonth, RootProfile.birthMonth);
        assert.equal(udoc.school, RootProfile.school);
        assert.equal(udoc.grade, RootProfile.grade);
        const profile = await agent.get('/user/2').expect(200);
        assert.match(profile.text, new RegExp(RootProfile.realName));
    });

    it('Profile completion cannot change an existing phone binding', async () => {
        await agent.post('/home/phone/profile')
            .send({
                operation: 'save',
                phone: '13700137000',
                ...RootProfile,
            })
            .expect(403);
        await agent.post('/home/phone/profile')
            .send({
                operation: 'save',
                ...RootProfile,
                school: 'Updated Root School',
            })
            .expect(200);
        const UserModel = require('../packages/hydrooj/src/model/user').default;
        const udoc = await UserModel.getByUname('system', Root.username);
        assert.equal(udoc.phone, '13900139000');
        assert.equal(udoc.school, 'Updated Root School');
    });

    it('Phone registration, login, TFA probe, and lost password', async () => {
        const phoneAgent = supertest.agent(require('@hydrooj/framework').httpServer);
        const phone = '13800138000';
        const password = '123456';
        await phoneAgent.post('/register')
            .send({ mode: 'phone', phone, ...PhoneUserProfile })
            .expect(200);
        const redirect = await phoneAgent.post('/register')
            .send({
                mode: 'phone', phone, ...PhoneUserProfile, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
            })
            .expect(302)
            .then((res) => res.headers.location);
        await phoneAgent.post('/register')
            .send({
                mode: 'phone', phone, ...PhoneUserProfile, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
            })
            .expect(403);
        await phoneAgent.post(redirect)
            .send({ uname: 'phoneuser', password, verifyPassword: password })
            .expect(302);
        await phoneAgent.post('/login')
            .send({ uname: phone, password })
            .expect(302);
        const UserModel = require('../packages/hydrooj/src/model/user').default;
        const udoc = await UserModel.getByUname('system', 'phoneuser');
        assert(udoc);
        assert.equal(udoc.realName, PhoneUserProfile.realName);
        assert.equal(udoc.birthYear, PhoneUserProfile.birthYear);
        assert.equal(udoc.birthMonth, PhoneUserProfile.birthMonth);
        assert.equal(udoc.school, PhoneUserProfile.school);
        assert.equal(udoc.grade, PhoneUserProfile.grade);
        const ownProfile = await phoneAgent.get(`/user/${udoc._id}`).expect(200);
        assert.match(ownProfile.text, new RegExp(PhoneUserProfile.realName));
        const otherProfile = await agent.get(`/user/${udoc._id}`).expect(200);
        assert.doesNotMatch(otherProfile.text, new RegExp(PhoneUserProfile.realName));
        await UserModel.setById(udoc._id, { tfa: true });
        await phoneAgent.get(`/user/tfa?q=${phone}`)
            .expect(200)
            .expect({ tfa: true, authn: false });
        await phoneAgent.post('/lostpass')
            .send({ mode: 'phone', phone })
            .expect(200);
        const lostpassRedirect = await phoneAgent.post('/lostpass')
            .send({ mode: 'phone', phone, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE })
            .expect(302)
            .then((res) => res.headers.location);
        assert.match(lostpassRedirect, /^\/lostpass\//);
    });

    it('Contest form exposes phone requirement option', async () => {
        const UserModel = require('../packages/hydrooj/src/model/user').default;
        await UserModel.setSuperAdmin(2);
        const res = await agent.get('/contest/create').expect(200);
        assert.match(res.text, /name="requirePhone"/);
    });

    it('Contest requiring real-name profile blocks incomplete attendees', async () => {
        const start = new Date(Date.now() + 3600 * 1000);
        const end = new Date(start.getTime() + 2 * 3600 * 1000);
        const ContestModel = require('../packages/hydrooj/src/model/contest');
        const tid = await ContestModel.add('system', 'Real-name Contest', 'profile required', 2, 'acm', start, end, [], false, {
            requirePhone: true,
        });
        const contestUrl = `/contest/${tid.toHexString()}`;
        const incompleteAgent = supertest.agent(require('@hydrooj/framework').httpServer);
        const redirect = await incompleteAgent.post('/register')
            .send({ mail: 'incomplete@example.com' })
            .expect(302)
            .then((res) => res.headers.location);
        await incompleteAgent.post(redirect)
            .send({ uname: 'incomplete', password: Root.password, verifyPassword: Root.password })
            .expect(302);
        const detail = await incompleteAgent.get(contestUrl).expect(200);
        assert.match(detail.text, /phone-auth-contest-profile/);
        assert.match(detail.text, /data-required="1"/);
        assert.match(detail.text, /data-complete="0"/);
        assert.match(detail.text, /phone-auth-contest-dialog/);
        const attendRedirect = await incompleteAgent.post(contestUrl)
            .send({ operation: 'attend' })
            .expect(302)
            .then((res) => res.headers.location);
        assert.match(attendRedirect, /^\/home\/phone\?/);
    });

    // TODO add more tests

    const results: Record<string, autocannon.Result> = {};
    if (process.env.BENCHMARK) {
        for (const route of routes) {
            it(`Performance test ${route}`, { timeout: 60000 }, async () => {
                const result = await autocannon({ url: `http://localhost:8888${route}` });
                assert(result.errors === 0, `test ${route} returns errors`);
                results[route] = result;
            });
        }
    }

    after(() => {
        if (process.env.BENCHMARK) {
            const metrics = Object.entries(results).map(([k, v]) => ({
                name: `Benchmark - ${k} - Req/sec`,
                unit: 'Req/sec',
                value: v.requests.average,
            }));
            writeFileSync('./benchmark.json', JSON.stringify(metrics, null, 2));
        }
        setTimeout(() => process.exit(0), 1000);
    });
});
