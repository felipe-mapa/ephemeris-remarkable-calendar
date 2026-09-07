-- The one and only user. No authentication: the server identifies itself by APP_USER_EMAIL.
insert into public.users (email) values ('felipe@pavanela.com')
on conflict (email) do nothing;
