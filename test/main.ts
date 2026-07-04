import assert from 'assert';
import { writeFileSync } from 'fs';
import autocannon from 'autocannon';
import {
    after, before, describe, it,
} from 'node:test';
import * as supertest from 'supertest';

const Root = {
    username: 'root',
    password: 'rootPass1',
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

    it('Registration methods follow phone-auth switches', async () => {
        const SystemModel = require('../packages/hydrooj/src/model/system').default;
        const enabled = process.env.HYDRO_SMS_ALIYUN_ENABLED;
        process.env.HYDRO_SMS_ALIYUN_ENABLED = '1';
        try {
            await SystemModel.set('phone-auth.allowMailRegistration', false);
            await SystemModel.set('phone-auth.allowPhoneRegistration', true);
            const phoneOnly = await agent.get('/register').expect(200);
            const currentYear = new Date().getFullYear();
            assert.doesNotMatch(phoneOnly.text, /name="mail"/);
            assert.match(phoneOnly.text, /name="phone"/);
            assert.match(phoneOnly.text, /data-phone-auth-sms-form/);
            assert.match(phoneOnly.text, /data-phone-auth-resend-sms/);
            assert.match(phoneOnly.text, /Username can contain only Chinese characters|用户名仅可使用汉字/);
            assert.match(phoneOnly.text, /name="birthYear" class="select" style="color:#111;background-color:#fff;"/);
            assert.match(phoneOnly.text, /<option value="" disabled hidden selected>/);
            assert.match(phoneOnly.text, new RegExp(`<option value="${currentYear - 30}"`));
            assert.doesNotMatch(phoneOnly.text, new RegExp(`<option value="${currentYear - 31}"`));
            await agent.post('/register')
                .send({ mode: 'mail', mail: 'blocked-mail@example.com' })
                .expect(403);
            await agent.post('/register')
                .send({
                    mode: 'phone',
                    uname: 'missingphone',
                    password: Root.password,
                    verifyPassword: Root.password,
                    ...PhoneUserProfile,
                })
                .expect(403);
            await agent.post('/lostpass')
                .send({ mode: 'phone' })
                .expect(403);
            await agent.post('/register')
                .send({
                    mode: 'phone',
                    phone: '13700137002',
                    uname: 'missingyear',
                    password: Root.password,
                    verifyPassword: Root.password,
                    realName: 'Missing Year',
                    birthMonth: '1',
                    school: 'Missing School',
                    grade: 'junior1',
                })
                .expect(403);
            await agent.post('/register')
                .send({
                    mode: 'phone',
                    phone: '13700137003',
                    uname: 'weakphone',
                    password: '12345678',
                    verifyPassword: '12345678',
                    ...PhoneUserProfile,
                })
                .expect(403);
            await agent.post('/register')
                .send({
                    mode: 'phone',
                    phone: '13700137004',
                    uname: 'bad.name',
                    password: Root.password,
                    verifyPassword: Root.password,
                    ...PhoneUserProfile,
                })
                .expect(403);

            await SystemModel.set('phone-auth.allowMailRegistration', true);
            await SystemModel.set('phone-auth.allowPhoneRegistration', false);
            const mailOnly = await agent.get('/register').expect(200);
            assert.match(mailOnly.text, /name="mail"/);
            assert.doesNotMatch(mailOnly.text, /name="phone"/);
            await agent.post('/register')
                .send({
                    mode: 'phone',
                    phone: '13700137001',
                    uname: 'disabledphone',
                    password: Root.password,
                    verifyPassword: Root.password,
                    ...PhoneUserProfile,
                })
                .expect(403);

            await SystemModel.set('phone-auth.allowMailRegistration', false);
            const disabled = await agent.get('/register').expect(200);
            assert.match(disabled.text, /Registration is currently disabled|注册当前已关闭/);
        } finally {
            await SystemModel.set('phone-auth.allowMailRegistration', true);
            await SystemModel.set('phone-auth.allowPhoneRegistration', true);
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
            .send({ uname: Root.username, password: '12345678', verifyPassword: '12345678' })
            .expect(403);
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
        const bindPage = await agent.get('/home/phone').expect(200);
        assert.match(bindPage.text, /data-phone-auth-sms-form/);
        assert.match(bindPage.text, /data-phone-auth-resend-sms/);
        await agent.post('/home/phone')
            .send({ ...RootProfile })
            .expect(403);
        const sendRes = await agent.post('/home/phone')
            .set('Accept', 'application/json')
            .send({ phone, ...RootProfile })
            .expect(200);
        assert.equal(sendRes.body.phoneSent, true);
        assert.equal(sendRes.body.expireSeconds, 300);
        await agent.post('/home/phone')
            .send({
                phone, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
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
        const password = 'phonePass1';
        const registerBody = {
            mode: 'phone',
            phone,
            uname: 'phoneuser',
            password,
            verifyPassword: password,
            ...PhoneUserProfile,
        };
        const available = await phoneAgent.get('/phone-auth/register/check')
            .query({ uname: registerBody.uname, phone })
            .expect(200);
        assert.equal(available.body.username.valid, true);
        assert.equal(available.body.username.available, true);
        assert.equal(available.body.phone.valid, true);
        assert.equal(available.body.phone.available, true);
        const invalid = await phoneAgent.get('/phone-auth/register/check')
            .query({ uname: 'bad.name', phone: 'abc' })
            .expect(200);
        assert.equal(invalid.body.username.valid, false);
        assert.equal(invalid.body.phone.valid, false);
        const registerSend = await phoneAgent.post('/register')
            .set('Accept', 'application/json')
            .send(registerBody)
            .expect(200);
        assert.equal(registerSend.body.phoneSent, true);
        assert.equal(registerSend.body.expireSeconds, 300);
        await phoneAgent.post('/register')
            .send({
                ...registerBody,
                smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
            })
            .expect(302)
            .expect('Location', /^\/home\/settings/);
        const duplicateAgent = supertest.agent(require('@hydrooj/framework').httpServer);
        const duplicated = await duplicateAgent.get('/phone-auth/register/check')
            .query({ uname: registerBody.uname, phone })
            .expect(200);
        assert.equal(duplicated.body.username.valid, true);
        assert.equal(duplicated.body.username.available, false);
        assert.equal(duplicated.body.phone.valid, true);
        assert.equal(duplicated.body.phone.available, false);
        await duplicateAgent.post('/register')
            .send({
                ...registerBody,
                uname: 'phoneuser2',
                smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE,
            })
            .expect(403);
        const loginAgent = supertest.agent(require('@hydrooj/framework').httpServer);
        await loginAgent.post('/login')
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
        const ownProfile = await loginAgent.get(`/user/${udoc._id}`).expect(200);
        assert.match(ownProfile.text, new RegExp(PhoneUserProfile.realName));
        const otherProfile = await agent.get(`/user/${udoc._id}`).expect(200);
        assert.doesNotMatch(otherProfile.text, new RegExp(PhoneUserProfile.realName));
        await UserModel.setById(udoc._id, { tfa: true });
        await loginAgent.get(`/user/tfa?q=${phone}`)
            .expect(200)
            .expect({ tfa: true, authn: false });
        const lostpassAgent = supertest.agent(require('@hydrooj/framework').httpServer);
        const lostpassSend = await lostpassAgent.post('/lostpass')
            .set('Accept', 'application/json')
            .send({ mode: 'phone', phone })
            .expect(200);
        assert.equal(lostpassSend.body.phoneSent, true);
        assert.equal(lostpassSend.body.expireSeconds, 300);
        const lostpassRedirect = await lostpassAgent.post('/lostpass')
            .send({ mode: 'phone', phone, smsCode: process.env.HYDRO_SMS_ALIYUN_TEST_CODE })
            .expect(302)
            .then((res) => res.headers.location);
        assert.match(lostpassRedirect, /^\/lostpass\//);
        await lostpassAgent.post(lostpassRedirect)
            .send({ password: '12345678', verifyPassword: '12345678' })
            .expect(403);
        await lostpassAgent.post(lostpassRedirect)
            .send({ password: 'phoneReset1', verifyPassword: 'phoneReset1' })
            .expect(302);
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
