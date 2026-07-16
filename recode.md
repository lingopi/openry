我们需要开发一个开源的项目，你先理解我所说的，然后你和我先讨论，但不要动手开始构建项目。这个项目是让openclaw这种agent上搭建一个workflow体系，workflow使用状态机和硬代码控制。这个项目的核心代码就是做一个命令转发器，要求所有re-act agent 调用工具或命令时，必须使用我们的命令转发器，例如：openry --command 'echo "hello"'，然后返回的内容是附带状态机的固定json结构，当然json里有运行命令后返回的原始内容。这个项目要求使用python代码，先从转发器这一个核心组件开始开发，但是你要考虑通用性，用户可能会在linux,windows,macos上使用，所以命令转发器是核心最重要的，windows上powershell对引号特别不友好，所以我们看看能否使用arg的方式把命令拆成块，而不是使用--commad ‘’的方式来转发命令，我们的转发器的主要能力是转发执行命令，生成执行命令和返回结果的session.json记录文档。你看看还有什么不懂的吗

# task
先理解我所说的，然后你和我先讨论，但不要动手开始构建项目。我们需要开发一个命令转发器，这个转发器需要适配linux,windows,和macos系统。这个转发器我们起名叫openry，用python开发。

# 背景介绍
我们计划做一个re-act agent+workflow的项目，所以agent需要使用我们的openry 命令来做其他命令的转发，例如agent如果想查询目录结构，一般会使用ls。那么我们现在要去agent使用openry命令+ls命令，做到一个命令转发器的作用，返回的结果中要有workflow的状态机，例如返回结果应该是json结构，状态机包括但不限于task,workflow,step,status,created_at,updated_at,next_step等等，这样我们就可以用硬代码来路由和控制，而不是让agent自己决定，agent只负责动脑，硬代码负责动手。

1. openry --command 'python -m xxxx.py'我们还是使用这个做命令转发吧，后期我们安装时顺手安装powershell 7来解决不友好问题，因为argv涉及管道符问题，或者你有什么好建议可以提出来。
2. 他们之间的关系你可以理解为用户的终端上可能有多个workflow的配置文档（就像powerautomate的每个workflow都会有个配置文档），然后还会有多个步骤step，每个步骤干不同的事情，同一步骤还可能生成多次执行所以可以理解它是task。在这种情况下，硬代码需要判断现在有哪个workflow的哪个步骤的状态，硬代码再根据workflow的配置选择路由到哪一步。
3. 主动模式
4. 你整体规划一个目录树状结构来保存所有session，我建议按{workflow}/{step_number}/{session_id}.jsonl来保存
5. 返回的json里要考虑运行命令成功后的原始内容，报错内容等等

1. run_id我理解应该是随机生成的，且是一个step开始时生成的（step开始就像是openclaw的一个对话开始了），类似openclaw每个session都会在.openclaw/agents/session/目录下生成一个很长的随机id，这个id是用来追踪任务用的，而且在agent对一个step进行了多轮次的“工具调用+调用结果+思考”过程并且完成了这个step后，agent应该更新step状态，例如complete，这里我觉得就要run_id了。
2. 我同意你的建议
3. 我理解应该创建一个本地db保存这些吧？
4. 你给我可能的命令，我去windows上实际测试然后给你结果。
注意：我认为我们先做第一步，先把命令转发器做好！因为这个是核心


这个设计有问题，需要重新设计。
我认为agent只是大脑，每个workflow的不同的step，对应一个独立的全新的agent session。那么控制workflow编排的应该是硬代码，也就是说agent假设第一步要agent在某个step中，它只需要知道使用openry --command 'cd /data && ll'，而给agent指派工作的应该是工作了编排器（硬代码），你对这个方案有什么好的想法吗？