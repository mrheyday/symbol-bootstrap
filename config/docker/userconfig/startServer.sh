#!/bin/bash

name=$1
echo "RUNNING startServer.sh $name"
cd /symbol-workdir

ulimit -c unlimited
echo "!!!! Going to start server now...."
exec /usr/catapult/bin/catapult.server ./userconfig
