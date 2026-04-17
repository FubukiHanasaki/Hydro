import {
    BuiltinLoginError, Context, Handler, PERM, PRIV, Schema, SystemModel, TokenModel, UserAlreadyExistError,
    UserFacingError, UserModel, ValidationError, VerifyPasswordError,
} from 'hydrooj';
import { param, Types } from 'hydrooj';

const SMS_REGISTER_TOKEN = 10086;

function normalizePhone(phone: string) {
    const normalized = phone.trim().replace(/\D+/g, '');
    if (normalized.length < 6 || normalized.length > 20) throw new ValidationError('phone');
    return normalized;
}

function maskPhone(phone: string) {
    if (phone.length <= 4) return phone;
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function generateVerificationCode() {
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

function syntheticMail(phone: string) {
    return `sms-${phone}@sms.local`;
}

export const Config = Schema.object({
    codeExpireSeconds: Schema.number().min(60).step(1).default(300).description('SMS verification code expire seconds'),
    aliyun: Schema.object({
        accessKeyId: Schema.string().default('').description('Aliyun AccessKey ID'),
        accessKeySecret: Schema.string().default('').role('secret').description('Aliyun AccessKey Secret'),
        endpoint: Schema.string().default('dysmsapi.aliyuncs.com').description('Aliyun SMS endpoint'),
        regionId: Schema.string().default('cn-hangzhou').description('Aliyun region id'),
        signName: Schema.string().default('').description('Aliyun SMS sign name'),
        templateCode: Schema.string().default('').description('Aliyun SMS template code'),
    }).description('Aliyun SMS API entry points reserved for production use'),
});

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    const logger = ctx.logger('sms-registration-demo');

    async function sendSmsCode(phone: string, code: string) {
        // Demo mode: keep the Aliyun integration entry point here, but do not call the real SDK yet.
        logger.info(
            '[demo] Aliyun SMS placeholder: region=%s endpoint=%s sign=%s template=%s phone=%s code=%s',
            config.aliyun.regionId,
            config.aliyun.endpoint,
            config.aliyun.signName,
            config.aliyun.templateCode,
            phone,
            code,
        );
    }

    class SmsRegisterHandler extends Handler {
        noCheckPermView = true;

        async prepare() {
            if (!SystemModel.get('server.login')) throw new BuiltinLoginError();
        }

        async get() {
            this.response.template = 'sms_register.html';
        }

        @param('phone', Types.String)
        @param('uname', Types.Username, true)
        async post(domainId: string, phone: string, uname: string) {
            const normalizedPhone = normalizePhone(phone);
            const normalizedUname = uname.trim();
            if (!normalizedUname) throw new ValidationError('uname');
            await Promise.all([
                this.limitRate('sms_register_send', 60, 1, normalizedPhone),
                this.limitRate('sms_register_send_hour', 3600, 10, normalizedPhone),
            ]);
            if (await UserModel.getByUname('system', normalizedUname)) throw new UserAlreadyExistError(normalizedUname);
            if (await UserModel.coll.findOne({ phone: normalizedPhone })) throw new UserAlreadyExistError(normalizedPhone);

            const code = generateVerificationCode();
            await TokenModel.del(normalizedPhone, SMS_REGISTER_TOKEN);
            await TokenModel.add(
                SMS_REGISTER_TOKEN,
                config.codeExpireSeconds,
                {
                    phone: normalizedPhone,
                    uname: normalizedUname,
                    code,
                    redirect: this.request.referer || '',
                },
                normalizedPhone,
            );
            await sendSmsCode(normalizedPhone, code);
            this.response.redirect = this.url('sms_register_verify', { phone: normalizedPhone });
        }
    }

    class SmsRegisterVerifyHandler extends Handler {
        noCheckPermView = true;

        async prepare() {
            if (!SystemModel.get('server.login')) throw new BuiltinLoginError();
        }

        @param('phone', Types.String)
        async get(domainId: string, phone: string) {
            const normalizedPhone = normalizePhone(phone);
            const tdoc = await TokenModel.get(normalizedPhone, SMS_REGISTER_TOKEN);
            if (!tdoc) throw new UserFacingError('SMS verification code expired. Please resend.');
            this.response.template = 'sms_register_verify.html';
            this.response.body = {
                phone: normalizedPhone,
                maskedPhone: maskPhone(normalizedPhone),
                uname: tdoc.uname,
                expireSeconds: config.codeExpireSeconds,
            };
        }

        @param('phone', Types.String)
        @param('code', Types.String)
        @param('password', Types.Password)
        @param('verifyPassword', Types.Password)
        async post(domainId: string, phone: string, code: string, password: string, verifyPassword: string) {
            const normalizedPhone = normalizePhone(phone);
            const tdoc = await TokenModel.get(normalizedPhone, SMS_REGISTER_TOKEN);
            if (!tdoc) throw new UserFacingError('SMS verification code expired. Please resend.');
            if (String(tdoc.code) !== code.trim()) throw new ValidationError('code');
            if (password !== verifyPassword) throw new VerifyPasswordError();
            await TokenModel.del(normalizedPhone, SMS_REGISTER_TOKEN);

            const uid = await UserModel.create(
                syntheticMail(normalizedPhone),
                tdoc.uname,
                password,
                undefined,
                this.request.ip,
            );
            await UserModel.setById(uid, {
                phone: normalizedPhone,
                phoneVerified: true,
                phoneVerifiedAt: new Date(),
                registerVia: 'sms-demo',
            });
            const udoc = await UserModel.getById('system', uid);
            this.context.HydroContext.user = udoc;
            this.session.uid = uid;
            this.session.scope = PERM.PERM_ALL.toString();
            this.session.save = true;
            this.session.recreate = true;
            this.session.viewLang = '';
            this.session.sudo = null;
            this.session.sudoUid = null;
            this.session.oauthBind = null;
            this.response.redirect = this.url('homepage');
        }
    }

    ctx.injectUI('Nav', 'sms_register', { prefix: 'sms-register', text: 'SMS Sign Up' });
    ctx.Route('sms_register', '/sms-register', SmsRegisterHandler, PRIV.PRIV_REGISTER_USER);
    ctx.Route('sms_register_verify', '/sms-register/:phone', SmsRegisterVerifyHandler, PRIV.PRIV_REGISTER_USER);
}
