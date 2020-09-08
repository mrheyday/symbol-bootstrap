#!/bin/bash

name=$1
echo "RUNNING running startBroker.sh $name"

cd /symbol-workdir

ulimit -c unlimited

exec /usr/catapult/bin/catapult.broker ./userconfig
