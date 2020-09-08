#!/bin/bash
name=$1
echo "RUNNING runServerRecover.sh $name"

cd /symbol-workdir

ulimit -c unlimited
if [ -e "broker.lock" ] || [ -e "server.lock" ]; then
  echo "!!!! Have lock file present, going to run recovery...."
  exec /usr/catapult/bin/catapult.recovery ./userconfig
  echo "!!!! Finished running recovery, should be moving on to start server..."
else
  echo "!!!! DO NOT HAVE ANY LOCK FILE.."
  exit 0;
fi

