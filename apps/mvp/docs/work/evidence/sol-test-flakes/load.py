import os, subprocess, sys, time, multiprocessing
cpus=sorted(os.sched_getaffinity(0))[:int(os.environ.get('FLAKE_CPUS','2'))]
def burn(deadline):
    while time.monotonic() < deadline:
        os.sched_setaffinity(0, cpus)
        sum(i*i for i in range(10000))
for iteration in range(int(sys.argv[1])):
    os.sched_setaffinity(0, cpus)
    workers=[multiprocessing.Process(target=burn,args=(time.monotonic()+240,)) for _ in range(int(os.environ.get('FLAKE_BURNERS','2')))]
    for worker in workers: worker.start()
    try:
        print('LOAD RUN',iteration+1,'cpus',cpus,'burners',len(workers),'boundSeconds',240,flush=True)
        result=subprocess.run(sys.argv[2:])
        print('LOAD END',iteration+1,'exit',result.returncode,'burnersAlive',sum(w.is_alive() for w in workers),flush=True)
        if result.returncode: sys.exit(result.returncode)
    finally:
        for worker in workers:
            if worker.is_alive(): worker.terminate()
            worker.join()
