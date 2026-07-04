import { AutoloadPage, addPage } from '@hydrooj/ui-default';
import { setupSmsForms } from './sms';

const page = new AutoloadPage('phone_auth_sms_forms', () => {
  setupSmsForms();
});

addPage(page);

export default page;
