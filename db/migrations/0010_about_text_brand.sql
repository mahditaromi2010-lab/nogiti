-- Brand rename follow-up: the default About text seeded in 0001 still says "Nogiti". Update it only if it
-- is still exactly the untouched default, so text an admin has written is never overwritten.
UPDATE site_settings
   SET setting_value = 'Novingity بستری برای دسترسی به ابزارهای تخصصی تأسیسات، آموزش مهندسی و منابع کاربردی است.'
 WHERE setting_key = 'about_text'
   AND setting_value = 'Nogiti بستری برای دسترسی به ابزارهای تخصصی تأسیسات، آموزش مهندسی و منابع کاربردی است.';
