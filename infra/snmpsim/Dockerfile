# snmpsim — a pure-Python SNMP agent simulator, for the OAT SNMP live-signal demo ONLY.
#
# It stands in for a real network printer entirely inside the compose network: it serves the
# Printer-MIB page counter as an increasing value, so the OAT SNMP connector can observe real
# utilisation over the wire with no external network and nothing faked in the poll path. This
# image is never part of any production deployment — the app and worker images do not include it.
#
# Licence: snmpsim-lextudio is the maintained fork of Ilya Etingof's snmpsim, BSD-2-Clause —
# permissive, no copyleft obligation (CLAUDE.md guardrail). python:alpine is PSF/MIT-family.
FROM python:3.12-alpine

# Pinned: a reproducible demo must not drift when a new snmpsim ships.
RUN pip install --no-cache-dir "snmpsim-lextudio==1.1.1"

# A non-root account for snmpsim to drop to. Root binds the privileged UDP port 161, then the
# responder hands off to this user (--process-user/--process-group below).
RUN addgroup -S snmpsim && adduser -S -G snmpsim snmpsim

# The simulated device data. Served for community "public" (see public.snmprec).
COPY data/ /usr/local/snmpsim/data/

EXPOSE 161/udp

# Bind 0.0.0.0:161 so the worker reaches it as snmpsim:161 on the compose network. The
# responder speaks SNMP v1/v2c/v3; the connector uses v2c + community "public".
ENTRYPOINT ["snmpsim-command-responder", \
  "--data-dir=/usr/local/snmpsim/data", \
  "--agent-udpv4-endpoint=0.0.0.0:161", \
  "--process-user=snmpsim", \
  "--process-group=snmpsim", \
  "--logging-method=stderr"]
