import { createHash } from 'crypto';
import {
    ContestModel, Context, CreateError, ForbiddenError, Handler, InvalidTokenError, NotFoundError,
    OplogModel, PERM, PRIV, randomstring, Schema, SettingModel, SystemError, SystemModel, TokenModel, Types,
    UserAlreadyExistError, UserFacingError, UserModel, UserNotFoundError,
    ValidationError, VerifyPasswordError,
} from 'hydrooj';

export const name = 'phone-auth';
export const inject = ['oauth'];

export const Config = Schema.object({
    enabled: Schema.boolean().default(false).description('Enable phone authentication'),
    allowMailRegistration: Schema.boolean().default(true).description('Allow email registration'),
    allowPhoneRegistration: Schema.boolean().default(true).description('Allow phone registration'),
    accessKeyId: Schema.string().default('').description('Aliyun AccessKey ID').role('secret'),
    accessKeySecret: Schema.string().default('').description('Aliyun AccessKey Secret').role('secret'),
    endpoint: Schema.string().default('dypnsapi.aliyuncs.com').description('Aliyun SMS endpoint'),
    signName: Schema.string().default('').description('Aliyun SMS sign name'),
    templateCode: Schema.string().default('').description('Aliyun SMS template code'),
    codeLength: Schema.number().step(1).min(4).max(8).default(6).description('SMS verification code length'),
    expireSeconds: Schema.number().step(1).min(60).max(1800).default(300).description('SMS verification code lifetime'),
}).description('Phone Authentication');

type PhoneAuthConfig = ReturnType<typeof Config>;
let activeConfig: PhoneAuthConfig;

const TYPE_SMS_VERIFICATION = 1002;
const TYPE_PHONE_REGISTRATION = 1003;
const SMS_TOKEN_TEXT = 'SMS Verification';

const SendSmsError = CreateError('SendSmsError', UserFacingError, 'Failed to send SMS to {0}. ({1})', 500);
const RegistrationMethodDisabledError = CreateError(
    'RegistrationMethodDisabledError',
    ForbiddenError,
    '{0} registration is disabled.',
);
const WeakPasswordError = CreateError(
    'WeakPasswordError',
    ForbiddenError,
    'Password must be at least 8 characters and include both letters and numbers.',
);
const PhoneAlreadyRegisteredError = CreateError(
    'PhoneAlreadyRegisteredError',
    ForbiddenError,
    'Phone number {0} is already registered.',
);

const GRADE_OPTIONS = {
    primary1: 'Primary Grade 1',
    primary2: 'Primary Grade 2',
    primary3: 'Primary Grade 3',
    primary4: 'Primary Grade 4',
    primary5: 'Primary Grade 5',
    primary6: 'Primary Grade 6',
    junior1: 'Junior Grade 1',
    junior2: 'Junior Grade 2',
    junior3: 'Junior Grade 3',
    senior1: 'Senior Grade 1',
    senior2: 'Senior Grade 2',
    senior3: 'Senior Grade 3',
    other: 'Other',
};

const BIRTH_YEAR_LOOKBACK = 30;
const USERNAME_ALLOWED_RE = /^[A-Za-z0-9_\-\u4E00-\u9FA5]+$/;
const USERNAME_CHINESE_RE = /^[\u4E00-\u9FA5]+$/;

type ProfileFields = {
    realName: string;
    birthYear: string;
    birthMonth: string;
    school: string;
    grade: string;
};

function env(name: string) {
    return process.env[`HYDRO_SMS_ALIYUN_${name}`] || '';
}

function getConfig(config: PhoneAuthConfig) {
    return {
        enabled: config.enabled || ['1', 'true', 'yes', 'on'].includes(env('ENABLED').toLowerCase()),
        accessKeyId: config.accessKeyId || env('ACCESS_KEY_ID'),
        accessKeySecret: config.accessKeySecret || env('ACCESS_KEY_SECRET'),
        endpoint: config.endpoint || env('ENDPOINT') || 'dypnsapi.aliyuncs.com',
        signName: config.signName || env('SIGN_NAME'),
        templateCode: config.templateCode || env('TEMPLATE_CODE'),
        codeLength: +(config.codeLength || env('CODE_LENGTH') || 6),
        expireSeconds: +(config.expireSeconds || env('EXPIRE_SECONDS') || 300),
        testCode: env('TEST_CODE'),
    };
}

function isAliyunSmsEnabled(config: PhoneAuthConfig) {
    return getConfig(config).enabled;
}

function settingBool(key: string, fallback: boolean) {
    const value = SystemModel.get(key);
    return value === undefined ? fallback : !!value;
}

function isMailRegistrationEnabled(config: PhoneAuthConfig) {
    return settingBool('phone-auth.allowMailRegistration', config.allowMailRegistration !== false);
}

function isPhoneRegistrationEnabled(config: PhoneAuthConfig) {
    return settingBool('phone-auth.allowPhoneRegistration', config.allowPhoneRegistration !== false)
        && isAliyunSmsEnabled(config);
}

function normalizePhone(input: string) {
    const value = input.trim().replace(/[\s-]/g, '');
    const mainland = value.match(/^(?:\+?86|0086)?(1[3-9]\d{9})$/);
    if (mainland) return mainland[1];
    if (/^\+?[1-9]\d{5,19}$/.test(value)) return value.replace(/^\+/, '');
    throw new ValidationError('phone');
}

function normalizeUsername(input: string) {
    let value = '';
    try {
        value = Types.Username[0](input || '');
    } catch (e) {
        throw new ValidationError('uname');
    }
    const length = [...value].length;
    const validLength = USERNAME_CHINESE_RE.test(value)
        ? length >= 2 && length <= 31
        : length >= 3 && length <= 31;
    if (!USERNAME_ALLOWED_RE.test(value) || !validLength) throw new ValidationError('uname');
    return value;
}

function assertStrongPassword(password: string) {
    const value = `${password || ''}`;
    if (value.length < 8 || value.length > 255 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
        throw new WeakPasswordError();
    }
}

function assertNewPassword(password: string, verifyPassword: string) {
    if (password !== verifyPassword) throw new VerifyPasswordError();
    assertStrongPassword(password);
}

function maskPhone(phone: string) {
    if (phone.length <= 7) return phone.replace(/\d(?=\d{2})/g, '*');
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizeRealName(input: string) {
    const value = (input || '').trim();
    if (!value || [...value].length > 64) throw new ValidationError('realName');
    return value;
}

function birthYearOptions() {
    const current = new Date().getFullYear();
    return Object.fromEntries(Array.from({ length: BIRTH_YEAR_LOOKBACK + 1 }, (_, i) => {
        const year = (current - i).toString();
        return [year, year];
    }));
}

function birthMonthOptions() {
    return Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
        const month = (i + 1).toString();
        return [month, month];
    }));
}

function normalizeRequiredText(input: string, key: string, max = 128) {
    const value = (input || '').trim();
    if (!value || [...value].length > max) throw new ValidationError(key);
    return value;
}

function normalizeBirthYear(input: string) {
    const value = `${input || ''}`.trim();
    const year = +value;
    const current = new Date().getFullYear();
    if (!Number.isInteger(year) || year < current - BIRTH_YEAR_LOOKBACK || year > current) throw new ValidationError('birthYear');
    return year.toString();
}

function normalizeBirthMonth(input: string) {
    const value = `${input || ''}`.trim();
    const month = +value;
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new ValidationError('birthMonth');
    return month.toString();
}

function normalizeGrade(input: string) {
    const value = `${input || ''}`.trim();
    if (!Object.hasOwn(GRADE_OPTIONS, value)) throw new ValidationError('grade');
    return value;
}

function normalizeProfile(input: Record<string, any>): ProfileFields {
    return {
        realName: normalizeRealName(input.realName),
        birthYear: normalizeBirthYear(input.birthYear),
        birthMonth: normalizeBirthMonth(input.birthMonth),
        school: normalizeRequiredText(input.school, 'school'),
        grade: normalizeGrade(input.grade),
    };
}

function getProfileFromUser(udoc: any = {}) {
    return {
        realName: udoc.realName || '',
        birthYear: optionValue(udoc.birthYear, birthYearOptions()),
        birthMonth: optionValue(udoc.birthMonth, birthMonthOptions()),
        school: udoc.school || '',
        grade: optionValue(udoc.grade, GRADE_OPTIONS),
        phone: udoc.phone || '',
    };
}

function hasCompleteProfile(udoc: any = {}) {
    try {
        normalizeProfile(udoc);
        return true;
    } catch (e) {
        return false;
    }
}

function profileFormBody(profile: Record<string, any> = {}) {
    return {
        profile: {
            realName: profile.realName || '',
            birthYear: optionValue(profile.birthYear, birthYearOptions()),
            birthMonth: optionValue(profile.birthMonth, birthMonthOptions()),
            school: profile.school || '',
            grade: optionValue(profile.grade, GRADE_OPTIONS),
            phone: profile.phone || '',
        },
        birthYears: birthYearOptions(),
        birthMonths: birthMonthOptions(),
        gradeOptions: GRADE_OPTIONS,
    };
}

function optionValue(value: any, options: Record<string, any>) {
    const key = `${value || ''}`;
    return Object.hasOwn(options, key) ? key : '';
}

function assertOk(body: any, phone: string) {
    if (body?.success === true || body?.Success === true) return body;
    if (body?.code === 'OK' || body?.Code === 'OK') return body;
    throw new SendSmsError(maskPhone(phone), body?.message || body?.Message || body?.code || body?.Code || 'Unknown error');
}

async function createAliyunDypnsClient(config: PhoneAuthConfig) {
    const {
        enabled, accessKeyId, accessKeySecret, endpoint,
    } = getConfig(config);
    if (!enabled) throw new SystemError('SMS registration is not enabled');
    if (!accessKeyId || !accessKeySecret) throw new SystemError('Aliyun SMS is not configured');
    const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
    const OpenApi = require('@alicloud/openapi-client');
    return new Dypnsapi20170525.default(new OpenApi.Config({
        accessKeyId,
        accessKeySecret,
        endpoint: endpoint || 'dypnsapi.aliyuncs.com',
    }));
}

async function sendAliyunSmsCode(config: PhoneAuthConfig, phone: string, outId: string) {
    const {
        signName, templateCode, codeLength, expireSeconds, testCode,
    } = getConfig(config);
    if (testCode) return { Code: 'OK' };
    if (!signName || !templateCode) throw new SystemError('Aliyun SMS is not configured');
    try {
        const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
        const client = await createAliyunDypnsClient(config);
        const validTime = expireSeconds || 300;
        const request = new Dypnsapi20170525.SendSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: '86',
            signName,
            templateCode,
            templateParam: JSON.stringify({
                code: '##code##',
                min: Math.max(1, Math.ceil(validTime / 60)).toString(),
            }),
            codeLength: codeLength || 6,
            codeType: 1,
            duplicatePolicy: 1,
            interval: 60,
            validTime,
            outId,
        });
        const response = await client.sendSmsVerifyCode(request);
        return assertOk(response?.body || response, phone);
    } catch (e) {
        if (e instanceof SendSmsError) throw e;
        throw new SendSmsError(maskPhone(phone), e.message);
    }
}

async function verifyAliyunSmsCode(config: PhoneAuthConfig, phone: string, verifyCode: string, outId: string) {
    const { testCode } = getConfig(config);
    if (testCode) return verifyCode === testCode;
    try {
        const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
        const client = await createAliyunDypnsClient(config);
        const request = new Dypnsapi20170525.CheckSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: '86',
            verifyCode,
            caseAuthPolicy: 1,
            outId,
        });
        const response = await client.checkSmsVerifyCode(request);
        const body = assertOk(response?.body || response, phone);
        return body?.model?.verifyResult === 'PASS' || body?.Model?.VerifyResult === 'PASS';
    } catch (e) {
        if (e instanceof SendSmsError) throw e;
        throw new SendSmsError(maskPhone(phone), e.message);
    }
}

function setBody(that: Handler, body: Record<string, any>) {
    that.response.body = { ...(that.response.body || {}), ...body };
}

function registrationReservationId(phone: string) {
    return `phone-auth:register:${createHash('sha256').update(phone).digest('hex')}`;
}

function unsavedExpireSeconds() {
    return SystemModel.get('session.unsaved_expire_seconds');
}

function duplicateKey(e: any) {
    return e?.code === 11000 || e?.codeName === 'DuplicateKey';
}

function oauthService(ctx: Context) {
    return ctx.get('oauth') as Context['oauth'];
}

async function createOrUpdateSmsToken(expireSeconds: number, query: Record<string, any>, data: Record<string, any> = {}) {
    const [doc] = await TokenModel.getMulti(TYPE_SMS_VERIFICATION, query)
        .sort({ updateAt: -1 })
        .limit(1)
        .toArray();
    if (!doc) {
        const [tid] = await TokenModel.add(TYPE_SMS_VERIFICATION, expireSeconds, { ...query, ...data });
        return tid;
    }
    await TokenModel.update(doc._id, TYPE_SMS_VERIFICATION, expireSeconds, { ...query, ...data });
    return doc._id;
}

async function hasVerifiedPhone(ctx: Context, uid: number, udoc?: any) {
    if (udoc?.phone && udoc?.phoneVerified) return true;
    const relations = await oauthService(ctx).list(uid);
    return relations.some((relation) => relation.platform === 'phone');
}

async function hasCompleteRequiredProfile(ctx: Context, uid: number, udoc?: any) {
    return hasCompleteProfile(udoc) && await hasVerifiedPhone(ctx, uid, udoc);
}

async function getPhoneRelation(ctx: Context, uid: number) {
    const relations = await oauthService(ctx).list(uid);
    return relations.find((relation) => relation.platform === 'phone') || null;
}

async function bindVerifiedPhone(ctx: Context, uid: number, phone: string, profile: ProfileFields) {
    const coll = (oauthService(ctx) as any).coll;
    try {
        await coll.updateOne(
            { platform: 'phone', id: phone, uid },
            { $set: { platform: 'phone', id: phone, uid } },
            { upsert: true },
        );
    } catch (e) {
        if (duplicateKey(e)) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
        throw e;
    }
    await coll.deleteMany({ platform: 'phone', uid, id: { $ne: phone } });
    await UserModel.setById(uid, { phone, phoneVerified: true, ...profile });
}

async function successfulPhoneRegister(that: Handler, uid: number) {
    const udoc = await UserModel.getById(that.args.domainId, uid);
    await UserModel.setById(uid, { loginat: new Date(), loginip: that.request.ip });
    that.context.HydroContext.user = udoc;
    that.session.viewLang = '';
    that.session.uid = uid;
    that.session.sudo = null;
    that.session.sudoUid = null;
    that.session.scope = PERM.PERM_ALL.toString();
    that.session.oauthBind = null;
    that.session.recreate = true;
    await OplogModel.log(that, 'user.loginSuccess', { uid });
}

async function reservePhoneRegistration(phone: string) {
    const id = registrationReservationId(phone);
    try {
        await TokenModel.add(TYPE_PHONE_REGISTRATION, unsavedExpireSeconds(), { phone, purpose: 'register' }, id);
    } catch (e) {
        if (duplicateKey(e)) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
        throw e;
    }
    return id;
}

async function ensureRegisterAvailable(that: Handler, phone: string, uname: string) {
    if (await UserModel.getByUname(that.args.domainId, uname)) throw new UserAlreadyExistError(uname);
    if (await oauthService(that.ctx).get('phone', phone)) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
    if (await TokenModel.get(registrationReservationId(phone), TYPE_PHONE_REGISTRATION)) {
        throw new PhoneAlreadyRegisteredError(maskPhone(phone));
    }
}

class PhoneRegisterCheckHandler extends Handler {
    noCheckPermView = true;

    async get() {
        await this.limitRate('phone_auth_register_check', 60, 120);
        const unameInput = `${this.request.query.uname || ''}`;
        const phoneInput = `${this.request.query.phone || ''}`;
        const result: Record<string, any> = {};
        try {
            const uname = normalizeUsername(unameInput);
            const existing = await UserModel.getByUname(this.args.domainId, uname);
            result.username = {
                valid: true,
                available: !existing,
            };
        } catch (e) {
            result.username = { valid: false, available: false };
        }
        try {
            const phone = normalizePhone(phoneInput);
            const existing = await oauthService(this.ctx).get('phone', phone);
            const reserved = await TokenModel.get(registrationReservationId(phone), TYPE_PHONE_REGISTRATION);
            result.phone = {
                valid: true,
                available: !existing && !reserved,
            };
        } catch (e) {
            result.phone = { valid: false, available: false };
        }
        this.response.body = result;
    }
}

async function sendSmsRegister(that: Handler, config: PhoneAuthConfig, phoneInput: string, smsCode = '', profileInput: Record<string, any> = {}) {
    if (!isPhoneRegistrationEnabled(config)) throw new RegistrationMethodDisabledError('Phone');
    const phone = normalizePhone(phoneInput);
    const uname = normalizeUsername(profileInput.uname);
    assertNewPassword(profileInput.password, profileInput.verifyPassword);
    await ensureRegisterAvailable(that, phone, uname);
    const expireSeconds = getConfig(config).expireSeconds;
    if (!smsCode) {
        const profile = normalizeProfile(profileInput);
        await Promise.all([
            that.limitRate('send_sms', 60, 1, phone),
            that.limitRate('send_sms', 3600, 30),
            OplogModel.log(that, 'user.register.sms', {}),
        ]);
        const tid = await createOrUpdateSmsToken(expireSeconds, { phone, purpose: 'register' }, { profile, uname });
        try {
            await sendAliyunSmsCode(config, phone, tid);
        } catch (e) {
            await TokenModel.del(tid, TYPE_SMS_VERIFICATION);
            throw e;
        }
        if (that.request.json) {
            that.response.body = {
                phoneSent: true, expireSeconds, phone, uname,
            };
            return;
        }
        that.response.template = 'user_register.html';
        setBody(that, {
            mailEnabled: isMailRegistrationEnabled(config),
            phoneEnabled: true,
            phone,
            username: uname,
            phoneSent: true,
            expireSeconds,
            ...profileFormBody({ ...profile, phone }),
        });
        return;
    }
    await that.limitRate('verify_sms', 60, 5, phone);
    const [doc] = await TokenModel.getMulti(TYPE_SMS_VERIFICATION, { phone, purpose: 'register' })
        .sort({ updateAt: -1 })
        .limit(1)
        .toArray();
    if (!doc) throw new InvalidTokenError(SMS_TOKEN_TEXT);
    const profile = normalizeProfile(doc.profile || profileInput);
    if (doc.uname && doc.uname !== uname) throw new ValidationError('uname');
    const verified = await verifyAliyunSmsCode(config, phone, smsCode.trim(), doc._id);
    if (!verified) throw new InvalidTokenError(SMS_TOKEN_TEXT);
    const reservation = await reservePhoneRegistration(phone);
    try {
        await TokenModel.del(doc._id, TYPE_SMS_VERIFICATION);
        const uid = await UserModel.create(`${randomstring(12)}@invalid.local`, uname, profileInput.password, undefined, that.request.ip);
        await bindVerifiedPhone(that.ctx, uid, phone, profile);
        if (that.session.viewLang) await UserModel.setById(uid, { viewLang: that.session.viewLang });
        await TokenModel.del(reservation, TYPE_PHONE_REGISTRATION);
        await successfulPhoneRegister(that, uid);
        that.response.redirect = that.domain.registerRedirect || that.url('home_settings', { category: 'preference' });
    } catch (e) {
        await TokenModel.del(reservation, TYPE_PHONE_REGISTRATION);
        throw e;
    }
}

function rejectLegacyPhoneRegistrationToken(that: Handler & { tdoc?: any }) {
    if (that.tdoc?.identity?.provider === 'phone') throw new InvalidTokenError('Phone Registration');
}

async function sendPhoneLostPass(that: Handler, config: PhoneAuthConfig, phoneInput: string, smsCode = '') {
    if (!isAliyunSmsEnabled(config)) throw new SystemError('SMS registration is not enabled');
    const phone = normalizePhone(phoneInput);
    const uid = await oauthService(that.ctx).get('phone', phone);
    if (!uid || uid <= 0) throw new UserNotFoundError(maskPhone(phone));
    const expireSeconds = getConfig(config).expireSeconds;
    if (!smsCode) {
        await Promise.all([
            that.limitRate('send_sms_lostpass', 60, 1, phone),
            that.limitRate('send_sms_lostpass', 3600, 30),
            OplogModel.log(that, 'user.lostpass.sms', {}),
        ]);
        const tid = await TokenModel.createOrUpdate(TYPE_SMS_VERIFICATION, expireSeconds, { phone, uid, purpose: 'lostpass' });
        try {
            await sendAliyunSmsCode(config, phone, tid);
        } catch (e) {
            await TokenModel.del(tid, TYPE_SMS_VERIFICATION);
            throw e;
        }
        that.response.template = 'user_lostpass.html';
        setBody(that, {
            mailEnabled: !!SystemModel.get('smtp.user'),
            phoneEnabled: true,
            phone,
            phoneSent: true,
            expireSeconds,
        });
        return;
    }
    await that.limitRate('verify_sms_lostpass', 60, 5, phone);
    const [doc] = await TokenModel.getMulti(TYPE_SMS_VERIFICATION, { phone, purpose: 'lostpass' })
        .sort({ updateAt: -1 })
        .limit(1)
        .toArray();
    if (!doc) throw new InvalidTokenError(SMS_TOKEN_TEXT);
    const verified = await verifyAliyunSmsCode(config, phone, smsCode.trim(), doc._id);
    if (!verified) throw new InvalidTokenError(SMS_TOKEN_TEXT);
    await TokenModel.del(doc._id, TYPE_SMS_VERIFICATION);
    const [tid] = await TokenModel.add(TokenModel.TYPE_LOSTPASS, unsavedExpireSeconds(), { uid: doc.uid });
    that.response.redirect = that.url('user_lostpass_with_code', { code: tid });
}

class PhoneBindHandler extends Handler {
    async render(phone = '', profile: Record<string, any> = {}, phoneSent = false, prompt = false, redirect = '') {
        const relation = await getPhoneRelation(this.ctx, this.user._id);
        const displayPhone = phone || relation?.id || this.user.phone || '';
        this.response.template = 'phone_auth_bind.html';
        this.response.body = {
            enabled: isAliyunSmsEnabled(activeConfig),
            phone: displayPhone,
            phoneSent,
            prompt,
            redirect: redirect || this.url('home_security'),
            currentPhone: relation ? maskPhone(relation.id) : '',
            hasPhone: !!relation,
            expireSeconds: getConfig(activeConfig).expireSeconds,
            ...profileFormBody({ ...getProfileFromUser(this.user), ...profile, phone: displayPhone }),
        };
    }

    async get() {
        await this.render(
            '',
            {},
            false,
            !!this.request.query.prompt,
            this.request.query.redirect as string,
        );
    }

    async post() {
        if (!isAliyunSmsEnabled(activeConfig)) {
            throw new SystemError('SMS registration is not enabled');
        }
        const { phone: phoneInput, smsCode = '', redirect = '' } = this.request.body || {};
        const phone = normalizePhone(phoneInput);
        const profile = normalizeProfile(this.request.body || {});
        const expireSeconds = getConfig(activeConfig).expireSeconds;
        const existing = await oauthService(this.ctx).get('phone', phone);
        if (existing && existing !== this.user._id) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
        if (!smsCode) {
            await Promise.all([
                this.limitRate('send_sms_bind', 60, 1, phone),
                this.limitRate('send_sms_bind', 3600, 30),
                OplogModel.log(this, 'user.bind.sms', {}),
            ]);
            const tid = await createOrUpdateSmsToken(expireSeconds, {
                phone, uid: this.user._id, purpose: 'bind',
            }, { profile });
            try {
                await sendAliyunSmsCode(activeConfig, phone, tid);
            } catch (e) {
                await TokenModel.del(tid, TYPE_SMS_VERIFICATION);
                throw e;
            }
            await this.render(phone, profile, true, false, redirect);
            return;
        }
        await this.limitRate('verify_sms_bind', 60, 5, phone);
        const [doc] = await TokenModel.getMulti(TYPE_SMS_VERIFICATION, {
            phone, uid: this.user._id, purpose: 'bind',
        }).sort({ updateAt: -1 }).limit(1).toArray();
        if (!doc) throw new InvalidTokenError(SMS_TOKEN_TEXT);
        const verified = await verifyAliyunSmsCode(activeConfig, phone, smsCode.trim(), doc._id);
        if (!verified) throw new InvalidTokenError(SMS_TOKEN_TEXT);
        await bindVerifiedPhone(this.ctx, this.user._id, phone, normalizeProfile(doc.profile || profile));
        await TokenModel.del(doc._id, TYPE_SMS_VERIFICATION);
        this.session.phoneAuthPrompted = false;
        this.response.redirect = redirect || this.url('home_security');
    }
}

class PhoneProfileHandler extends Handler {
    async postSendSms() {
        if (!isAliyunSmsEnabled(activeConfig)) throw new SystemError('SMS registration is not enabled');
        const relation = await getPhoneRelation(this.ctx, this.user._id);
        if (relation) throw new ValidationError('phone');
        const phone = normalizePhone(this.request.body?.phone || '');
        const existing = await oauthService(this.ctx).get('phone', phone);
        if (existing && existing !== this.user._id) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
        await Promise.all([
            this.limitRate('send_sms_profile', 60, 1, phone),
            this.limitRate('send_sms_profile', 3600, 30),
            OplogModel.log(this, 'user.profile.sms', {}),
        ]);
        const tid = await createOrUpdateSmsToken(getConfig(activeConfig).expireSeconds, {
            phone, uid: this.user._id, purpose: 'profile',
        });
        try {
            await sendAliyunSmsCode(activeConfig, phone, tid);
        } catch (e) {
            await TokenModel.del(tid, TYPE_SMS_VERIFICATION);
            throw e;
        }
        this.response.body = { ok: true, expireSeconds: getConfig(activeConfig).expireSeconds };
    }

    async postSave() {
        const profile = normalizeProfile(this.request.body || {});
        const relation = await getPhoneRelation(this.ctx, this.user._id);
        if (relation) {
            if (this.request.body?.phone && normalizePhone(this.request.body.phone) !== relation.id) {
                throw new ValidationError('phone');
            }
            await UserModel.setById(this.user._id, profile);
            this.response.body = { ok: true };
            return;
        }
        if (!isAliyunSmsEnabled(activeConfig)) throw new SystemError('SMS registration is not enabled');
        const phone = normalizePhone(this.request.body?.phone || '');
        const existing = await oauthService(this.ctx).get('phone', phone);
        if (existing && existing !== this.user._id) throw new PhoneAlreadyRegisteredError(maskPhone(phone));
        await this.limitRate('verify_sms_profile', 60, 5, phone);
        const [doc] = await TokenModel.getMulti(TYPE_SMS_VERIFICATION, {
            phone, uid: this.user._id, purpose: 'profile',
        }).sort({ updateAt: -1 }).limit(1).toArray();
        if (!doc) throw new InvalidTokenError(SMS_TOKEN_TEXT);
        const verified = await verifyAliyunSmsCode(activeConfig, phone, `${this.request.body?.smsCode || ''}`.trim(), doc._id);
        if (!verified) throw new InvalidTokenError(SMS_TOKEN_TEXT);
        await bindVerifiedPhone(this.ctx, this.user._id, phone, profile);
        await TokenModel.del(doc._id, TYPE_SMS_VERIFICATION);
        this.session.phoneAuthPrompted = false;
        this.response.body = { ok: true };
    }
}

export function apply(ctx: Context, config: PhoneAuthConfig) {
    activeConfig = config;

    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(Schema.object({
            'phone-auth': Schema.object({
                allowMailRegistration: Schema.boolean().default(true).description('Allow email registration'),
                allowPhoneRegistration: Schema.boolean().default(true).description('Allow phone registration'),
            }).extra('family', 'setting_registration'),
        }));
        c.setting.AccountSetting(SettingModel.Setting(
            'setting_info',
            'realName',
            '',
            'text',
            'Real Name',
            'Real name is only visible to yourself and site administrators.',
            SettingModel.FLAG_PRIVATE,
        ), SettingModel.Setting(
            'setting_info',
            'birthYear',
            '',
            birthYearOptions(),
            'Birth Year',
            '',
            SettingModel.FLAG_PRIVATE,
        ), SettingModel.Setting(
            'setting_info',
            'birthMonth',
            '',
            birthMonthOptions(),
            'Birth Month',
            '',
            SettingModel.FLAG_PRIVATE,
        ), SettingModel.Setting(
            'setting_info',
            'grade',
            '',
            GRADE_OPTIONS,
            'Grade',
            '',
            SettingModel.FLAG_PRIVATE,
        ));
    });

    oauthService(ctx).provide('phone', {
        text: 'Phone',
        name: 'phone',
        hidden: true,
        async get() {
            throw new NotFoundError();
        },
        async callback() {
            throw new NotFoundError();
        },
    });

    ctx.Route('phone_auth_bind', '/home/phone', PhoneBindHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('phone_auth_profile', '/home/phone/profile', PhoneProfileHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('phone_auth_register_check', '/phone-auth/register/check', PhoneRegisterCheckHandler);

    (ctx.on as any)('user/login', async (that: Handler, payload) => {
        if (payload.udoc) return;
        try {
            const phone = normalizePhone(payload.login);
            const uid = await oauthService(that.ctx).get('phone', phone);
            if (uid && uid > 0) payload.udoc = await UserModel.getById(payload.domainId, uid);
        } catch (e) { }
    });

    ctx.on('handler/after/UserRegister#get', (that) => {
        setBody(that, {
            mailEnabled: isMailRegistrationEnabled(config),
            phoneEnabled: isPhoneRegistrationEnabled(config),
            ...profileFormBody(),
        });
    });

    ctx.on('handler/before/UserRegister#post', async (that) => {
        const {
            mail, mode, phone, smsCode,
        } = that.request.body || {};
        if ((mode === 'mail' || mail) && !isMailRegistrationEnabled(config)) {
            throw new RegistrationMethodDisabledError('Email');
        }
        if ((mode === 'phone' || phone) && !isPhoneRegistrationEnabled(config)) {
            throw new RegistrationMethodDisabledError('Phone');
        }
        if (mode !== 'phone' && !phone) return;
        await sendSmsRegister(that, config, phone, smsCode || '', that.request.body || {});
        return 'cleanup';
    });

    ctx.on('handler/before/UserRegisterWithCode#post', async (that) => {
        if (that.tdoc?.identity?.provider === 'mail' && !isMailRegistrationEnabled(config)) {
            throw new RegistrationMethodDisabledError('Email');
        }
        rejectLegacyPhoneRegistrationToken(that);
        assertNewPassword(`${that.request.body?.password || ''}`, `${that.request.body?.verifyPassword || ''}`);
    });

    ctx.on('handler/before/UserRegisterWithCode#get', (that) => {
        rejectLegacyPhoneRegistrationToken(that);
    });

    ctx.on('handler/after/UserLostPass#get', (that) => {
        setBody(that, {
            mailEnabled: !!SystemModel.get('smtp.user'),
            phoneEnabled: isAliyunSmsEnabled(config),
        });
    });

    ctx.on('handler/before/UserLostPass#post', async (that) => {
        const { mode, phone, smsCode } = that.request.body || {};
        if (mode !== 'phone' && !phone) return;
        await sendPhoneLostPass(that, config, phone, smsCode || '');
        return 'cleanup';
    });

    ctx.on('handler/before/UserLostPassWithCode#post', (that) => {
        assertNewPassword(`${that.request.body?.password || ''}`, `${that.request.body?.verifyPassword || ''}`);
    });

    ctx.on('handler/before-operation/HomeSecurity', (that) => {
        if (that.request.body?.operation !== 'change_password') return;
        assertNewPassword(`${that.request.body?.password || ''}`, `${that.request.body?.verifyPassword || ''}`);
    });

    ctx.on('handler/after/UserLogin#post', async (that) => {
        if (!isAliyunSmsEnabled(config)) return;
        const uid = that.session.uid;
        if (!uid || uid <= 0 || that.session.phoneAuthPrompted) return;
        const udoc = await UserModel.getById(that.args.domainId, uid);
        if (await hasVerifiedPhone(that.ctx, uid, udoc)) return;
        that.session.phoneAuthPrompted = true;
        that.response.redirect = that.url('phone_auth_bind', {
            query: {
                prompt: 1,
                redirect: that.response.redirect || that.url('homepage'),
            },
        });
    });

    ctx.on('handler/after/HomeSecurity#get', async (that) => {
        const relation = (that.response.body.relations || []).find((r) => r.platform === 'phone');
        setBody(that, {
            phoneAuth: {
                enabled: isAliyunSmsEnabled(config),
                hasPhone: !!relation,
                phone: relation ? maskPhone(relation.id) : '',
                bindUrl: that.url('phone_auth_bind', { query: { redirect: that.url('home_security') } }),
                profile: getProfileFromUser(that.user),
                gradeOptions: GRADE_OPTIONS,
            },
        });
    });

    ctx.on('handler/after/UserDetail#get', (that) => {
        setBody(that, {
            gradeOptions: GRADE_OPTIONS,
        });
    });

    ctx.on('handler/after/ContestEdit#post', async (that) => {
        if (that.request.body?.operation && that.request.body.operation !== 'update') return;
        const tid = that.response.body?.tid || that.args.tid || that.tdoc?.docId;
        if (!tid) return;
        await ContestModel.edit(that.args.domainId, tid, { requirePhone: !!that.request.body?.requirePhone } as any);
    });

    ctx.on('handler/after/ContestDetail#get', async (that) => {
        const requirePhone = !!(that.response.body?.tdoc as any)?.requirePhone;
        const relation = that.user._id > 0 ? await getPhoneRelation(that.ctx, that.user._id) : null;
        const hasPhone = that.user._id > 0 ? await hasVerifiedPhone(that.ctx, that.user._id, that.user) : false;
        const profile = getProfileFromUser(that.user);
        setBody(that, {
            phoneAuth: {
                requirePhone,
                hasPhone,
                completeProfile: that.user._id > 0 ? hasCompleteProfile(that.user) && hasPhone : false,
                phone: relation ? relation.id : profile.phone,
                maskedPhone: relation ? maskPhone(relation.id) : '',
                profile,
                profileUrl: that.url('phone_auth_profile'),
                ...profileFormBody(profile),
                bindUrl: that.url('phone_auth_bind', {
                    query: {
                        redirect: that.url('contest_detail', { tid: that.tdoc.docId }),
                        prompt: 1,
                    },
                }),
            },
        });
    });

    ctx.on('handler/before-operation/ContestDetail', async (that) => {
        if (that.request.body?.operation !== 'attend') return;
        if (!(that.tdoc as any)?.requirePhone || that.user._id <= 0) return;
        if (await hasCompleteRequiredProfile(that.ctx, that.user._id, that.user)) return;
        that.response.redirect = that.url('phone_auth_bind', {
            query: {
                redirect: that.url('contest_detail', { tid: that.tdoc.docId }),
                prompt: 1,
            },
        });
        return 'cleanup';
    });
}
