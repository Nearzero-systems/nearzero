-- 0780: a server's public IPv4, set by a person (spec 09 9.2, 10.2, 10.7). A server reached by a
-- hostname or a private address doesn't tell Nearzero where its hostnames should point; this
-- does, ahead of its address.
ALTER TABLE server ADD COLUMN public_ipv4 text CHECK (public_ipv4 ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$');
